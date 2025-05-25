const functions = require('firebase-functions'); // 1st gen import
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
admin.initializeApp();

const openai = new OpenAI({ 
  apiKey: (functions.config().openai && functions.config().openai.api_key) || process.env.OPENAI_API_KEY
});

const db = admin.firestore();

// Helper: Get user profile
async function getUserProfile(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }
  const userRef = db.collection('clients2').doc(userId);
  const doc = await userRef.get();
  if (!doc.exists) {
    return null;
  }
  return doc.data().profile;
}

// Helper: Get summary for user
async function getSummaryForUser(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }
  const userRef = db.collection('clients2').doc(userId);
  const doc = await userRef.get();
  if (!doc.exists) {
    return null;
  }
  return doc.data().summary;
}

// Helper: Get plan for user
async function getPlanForUser(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }
  const plansRef = db.collection('clients2').doc(userId).collection('plans');
  const snapshot = await plansRef.orderBy('start_date', 'desc').limit(1).get();
  if (snapshot.empty) {
    return null;
  }
  return snapshot.docs[0].data();
}

// Helper: Get events for user
async function getEventsForUser(userId, limit) {
  if (!userId) {
    throw new Error('userId is required');
  }
  const eventsRef = db.collection('clients2').doc(userId).collection('events');
  let query = eventsRef.orderBy('time', 'desc');
  if (limit) {
    query = query.limit(limit);
  }
  const snapshot = await query.get();
  return snapshot.docs.map(doc => doc.data());
}

// Helper: Draft message using OpenAI Assistant API
async function draftMessage({ situation, audience = "neutral", tone = "neutral" }) {
  try {
    const thread = await openai.beta.threads.create();
    const content = `Situation: ${situation}\nAudience: ${audience}\nTone: ${tone}`;
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content
    });
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: functions.config().openai.assistant_id
    });

    let runStatus;
    let attempts = 0;
    const maxAttempts = 20;
    do {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
    } while (
      (runStatus.status === 'queued' || runStatus.status === 'in_progress') &&
      attempts < maxAttempts
    );

    if (runStatus.status === 'completed') {
      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMsg = messages.data.reverse().find(m => m.role === 'assistant');
      return lastMsg?.content[0]?.text?.value || '';
    } else {
      throw new Error('OpenAI run failed: ' + (runStatus.last_error?.message || runStatus.status));
    }
  } catch (err) {
    throw err;
  }
}

// Helper: Generate coach message
async function generateCoachMessage({ userId, toneParam }) {
  // Fetch all required data
  const [profile, summary, plan, events] = await Promise.all([
    getUserProfile(userId),
    getSummaryForUser(userId),
    getPlanForUser(userId),
    getEventsForUser(userId)
  ]);

  // Prepare event snippets (last 3 events, most recent first)
  const last3Events = (events || []).slice(0, 3).map(e =>
    `[${e.timestamp || e.time}] ${e.type || ''}: ${e.content || e.body || ''}`
  ).join('\n');

  // Prepare plan snapshot (goals and tactics)
  let planSnapshot = '';
  if (plan && plan.goals) {
    planSnapshot = plan.goals.map(goal =>
      `Goal: ${goal.title}\nTactics: ${goal.tactics.map(t => t.title).join(', ')}`
    ).join('\n');
  }

  const audience = profile.clientName || 'client';
  const coachingStyle = profile.coachingStyle || '';
  const tone = coachingStyle + (toneParam ? ` ${toneParam}` : '');
  const randomWordCount = Math.floor(Math.random() * (35 - 15 + 1)) + 15;
  const situation = `
SYSTEM: You are CoachGPT, a personal training assistant. Based on the client's profile, current plan, recent events, and their FSM state, draft a message. Always prioritize replying if the last message was inbound from the client. Otherwise, act proactively based on their state.

CONTEXT:
CLIENT NAME: ${profile.clientName}
STYLE: ${profile.coachingStyle}
GOAL: ${profile.goal}
STATE: ${summary.Status}
SUMMARY: ${summary.Summary}
LAST 3 EVENTS:
${last3Events}

PLAN SNAPSHOT:
${planSnapshot}

RULES:
- If latest message was inbound, draft a warm, relevant reply (no matter the FSM state).
- If proactive, follow the logic:

  → STATE: Onboarding
     • Nudge client to complete plan setup (goals, preferences, schedule).
     • Ask about missing info with a helpful tone.

  → STATE: Engaged
     • Keep momentum high but low-pressure.
     • Highlight wins, praise consistency, suggest minor challenges.

  → STATE: At Risk
     • Gently flag missed activity or low check-in rate.
     • Offer support or simplification. Ask what's been hard.

  → STATE: Renewal
     • Nudge client to book a 1:1 to plan next phase.
     • Remind them how far they've come, and suggest a goal reset.

TONE GUIDE: Use the client's coachingStyle to shape the voice.
- Therapist: curious, patient, reflective
- Cheerleader: energetic, supportive, informal
- Analyst: precise, neutral, results-focused
- DrillSergeant: crisp, motivating, directive

INSTRUCTION:
Draft a message (${randomWordCount} words max) based on the above.
`;

  const draftRaw = await draftMessage({ situation, audience, tone });
  let draft = draftRaw;
  // Remove markdown code block if present
  let cleaned = draftRaw;
  if (typeof cleaned === 'string') {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/```\s*$/, '').trim();
  }
  // Parse as JSON and return only the draft field
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && parsed.draft) {
      draft = parsed.draft;
    } else {
      draft = cleaned;
    }
  } catch (e) {
    draft = cleaned;
  }
  return draft;
}

exports.analyzeMessageEvent = functions.firestore
  .document('clients2/{clientId}/events/{eventId}')
  .onCreate(async (snap, context) => {
    const { clientId, eventId } = context.params;
    const eventData = snap.data();
    let createdEvents = [];

    console.log(`[analyzeMessageEvent] Triggered for clientId: ${clientId}, eventId: ${eventId}`);
    console.log('[analyzeMessageEvent] eventData:', JSON.stringify(eventData));

    // Skip if it's not an inbound message
    if (eventData.type !== "message" || eventData.inbound === false) {
      console.log("Not an inbound client message. Skipping.");
      return createdEvents;
    }

    // Fetch last 5 events
    const recentMessagesSnapshot = await admin.firestore()
      .collection(`clients2/${clientId}/events`)
      .orderBy('time', 'desc')
      .limit(5)
      .get();

    const recentMessages = recentMessagesSnapshot.docs.map(doc => doc.data());
    console.log('[analyzeMessageEvent] recentMessages:', JSON.stringify(recentMessages));

    // Fetch plan data
    const plansSnapshot = await admin.firestore()
      .collection(`clients2/${clientId}/plans`)
      .get();
    const plans = plansSnapshot.docs.map(doc => doc.data());
    console.log('[analyzeMessageEvent] plans:', JSON.stringify(plans));

    // Find the current plan
    const now = new Date();
    let currentPlan = null;
    for (const plan of plans) {
      if (plan.start_date && plan.end_date) {
        const start = new Date(plan.start_date);
        const end = new Date(plan.end_date);
        if (now >= start && now <= end) {
          currentPlan = plan;
          break;
        }
      }
    }
    const planId = currentPlan ? currentPlan.planId : null;
    console.log('[analyzeMessageEvent] current planId:', planId);

    // --- 1. Plan Update Analysis ---
    if (planId) {
      // Only do plan analysis if the plan has tactics and measurements with completions and recordings arrays (empty or otherwise)
      const hasProgressAndMeasurements = currentPlan && Array.isArray(currentPlan.goals) && currentPlan.goals.some(goal =>
        (Array.isArray(goal.tactics) && goal.tactics.some(t => Array.isArray(t.completions))) &&
        (Array.isArray(goal.measurements) && goal.measurements.some(m => Array.isArray(m.recordings)))
      );
      if (hasProgressAndMeasurements) {
        // Prepare a concise plan summary for the LLM prompt
        const planGoalsSummary = (currentPlan.goals || []).map((goal, idx) => {
          const tactics = (goal.tactics || []).map(t => `    - ${t.title} [${t.frequency}]`).join('\n');
          const measurements = (goal.measurements || []).map(m => `    - ${m.title} (${m.unit}, start: ${m.start}, goal: ${m.goal})`).join('\n');
          return `Goal ${idx + 1}: ${goal.title}\n  Tactics:\n${tactics}\n  Measurements:\n${measurements}`;
        }).join('\n\n');

        // LLM Prompt (updated for RESTful path and payload)
        const planUpdatePrompt = `
      SYSTEM: You help fitness coaches track progress from client messages.
      Given recent messages and the client's plan, determine if the most recent message implies any completed tactic or measurable change.

      MESSAGES (latest first): ${JSON.stringify(recentMessages)}
CLIENT PLAN GOALS, TACTICS, MEASUREMENTS:\n${planGoalsSummary}

EXAMPLES:

(assume user id 12345 and plan id ABC)

If the plan has these goals and tactics:
- Goal: "Lose 10 lbs"
  - Tactic: "Do 4 workouts per week"
  - Tactic: "Log your food daily"
- Goal: "Reduce stress"
  - Measurement: "Meditate 500 minutes in total"

And the following messages are received:
- "I just got home from my workout!"
- "Here are my macros for today"
- "Finished my meditation, 10 mins this time!"

You might generate these events:

// Tactic completion example
{
  "actionRequired": true,
  "description": "Add a completion for tactic \"Do 4 workouts per week\" in goal \"Lose 10 lbs\"",
  "api_call": {
    "method": "POST",
    "path": "/clients2/12345/plans/ABC/goals/lose_10_lbs/tactics/Do_4_workouts_per_week/completions",
    "body": {
      "timestamp": "YYYY-MM-DDThh:mm:ssZ",
      "sourceEvent": "<relatedEventId>"
    }
  }
}

// Measurement log example
{
  "actionRequired": true,
  "description": "Add a recording of 10 to measurement \"Meditate 500 minutes in total\" in goal \"Reduce stress\"",
  "api_call": {
    "method": "POST",
    "path": "/clients2/12345/plans/ABC/goals/reduce_stress/measurements/meditate_500_minutes_in_total/logs",
    "body": {
      "timestamp": "YYYY-MM-DDThh:mm:ssZ",
      "value": 10,
      "sourceEvent": "<relatedEventId>"
    }
  }
}

If the message does not clearly imply a plan update, return actionRequired: false and api_call: null.

If the message implies a plan update, provide:
- A concise, human-readable instruction for the coach (description)
- The full REST API path (including userId and planId) for the plan change, following the API documented below.
- The JSON payload (body) for the API call, as a separate key.

If there's nothing relevant, say "No relevant progress identified." and set api_call to null.

REST API DOCS (for plan updates):

1. Mark Tactic Completion
POST /clients2/{userId}/plans/{planId}/goals/{goal_title_with_underscores}/tactics/{tactic_title_with_underscores}/completions
Body:
{
  "timestamp": "2025-07-03T18:00:00Z",
  "sourceEvent": "event id"
}

2. Log Measurement
POST /clients2/{userId}/plans/{planId}/goals/{goal_title_with_underscore}/measurements/{masurement_title_with_underscore}/logs
Body:
{
  "date": "2025-07-05",
  "value": 210,
  "sourceEvent": "event id"
}

Only suggest an API call if the message clearly implies a plan update, tactic completion, or measurement log.

      RESPOND IN JSON FORMAT:
      {
        "actionRequired": true|false,
  "description": "Add a recording of <value> to measurement \"<measurement_title>>\" in goal \"<goal_title>\" | Add a completion to tactic \"<tactic_title>\" in goal \"<goal_title>\"",
  "api_call": {
    "method": "POST",
    "path": "/clients2/{userId}/plans/{planId}/goals/{goal_title_with_underscore}/measurements/{measurement_title_with_underscore}/logs | /clients2/{userId}/plans/{planId}/goals/{goal_title_with_underscores}/tactics/{tactic_title_with_underscores}/completions",
    "body": { ... }
  } | null
}

- Only include the api_call object (do not repeat the payload or path elsewhere).
- For sourceEvent, always use the event document ID (provided as relatedEventId), not the activity_id.

Make sure api_call is always present and correct if actionRequired is true.
`;

        console.log('[analyzeMessageEvent] LLM prompt:', planUpdatePrompt);

        const planUpdateResponse = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
          messages: [{ role: 'system', content: planUpdatePrompt }],
      response_format: { type: "json_object" },
    });

        console.log('[analyzeMessageEvent] LLM raw response:', JSON.stringify(planUpdateResponse));

        let analysis;
        try {
          analysis = JSON.parse(planUpdateResponse.choices[0].message.content);
          console.log('[analyzeMessageEvent] Parsed LLM analysis:', JSON.stringify(analysis));
        } catch (err) {
          console.error("Failed to parse LLM response:", planUpdateResponse.choices[0].message.content);
          throw err;
        }

        // Inject actual userId and planId into api_call.path if present
        if (analysis.api_call && analysis.api_call.path) {
          console.log('[PlanUpdateSuggestionEvent] BEFORE path:', analysis.api_call.path);
          analysis.api_call.path = analysis.api_call.path
            .replace(/{userId}/gi, encodeURIComponent(clientId))
            .replace(/{planId}/gi, planId);
          console.log('[PlanUpdateSuggestionEvent] AFTER path:', analysis.api_call.path);
        }

        // Validate LLM response
        let apiPath = null;
        let apiPayload = null;
        let apiCall = null;
        let isValid = true;
        let validationError = null;
        if (analysis.actionRequired) {
          apiPath = analysis.api_path || (analysis.api_call && analysis.api_call.path);
          apiPayload = analysis.api_payload || (analysis.api_call && analysis.api_call.body);
          apiCall = analysis.api_call;
          // Check that apiPath includes userId and planId
          if (!apiPath || !apiPath.includes(clientId) || !apiPath.includes(planId)) {
            isValid = false;
            validationError = `api_path missing or does not include userId/planId: ${apiPath}`;
            console.error(validationError);
          }
          // Check that apiPayload is an object
          if (!apiPayload || typeof apiPayload !== 'object') {
            isValid = false;
            validationError = `api_payload missing or not an object: ${apiPayload}`;
            console.error(validationError);
          }
          // Enhanced validation: check goal/tactic/measurement existence
          if (apiCall && apiCall.path) {
            // Ensure path contains both clientId and planId
            if (!apiCall.path.includes(clientId) || !apiCall.path.includes(planId)) {
              isValid = false;
              validationError = `api_call.path missing clientId or planId after replacement: ${apiCall.path}`;
              console.error(validationError);
            }
            // Extract goal, tactic, measurement from path
            const goalMatch = apiCall.path.match(/goals\/([^/]+)/);
            const tacticMatch = apiCall.path.match(/tactics\/([^/]+)/);
            const measurementMatch = apiCall.path.match(/measurements\/([^/]+)/);
            const goalTitle = goalMatch ? goalMatch[1].replace(/_/g, ' ') : null;
            const tacticTitle = tacticMatch ? tacticMatch[1].replace(/_/g, ' ') : null;
            const measurementTitle = measurementMatch ? measurementMatch[1].replace(/_/g, ' ') : null;
            let foundGoal = null;
            if (goalTitle && Array.isArray(currentPlan.goals)) {
              foundGoal = currentPlan.goals.find(g => g.title.toLowerCase() === goalTitle.toLowerCase());
              if (!foundGoal) {
                isValid = false;
                validationError = `Goal title not found in plan: ${goalTitle}`;
                console.error(validationError);
              }
            }
            if (foundGoal && tacticTitle) {
              const foundTactic = (foundGoal.tactics || []).find(t => t.title.toLowerCase() === tacticTitle.toLowerCase());
              if (!foundTactic) {
                isValid = false;
                validationError = `Tactic title not found in goal '${goalTitle}': ${tacticTitle}`;
                console.error(validationError);
              }
            }
            if (foundGoal && measurementTitle) {
              const foundMeasurement = (foundGoal.measurements || []).find(m => m.title.toLowerCase() === measurementTitle.toLowerCase());
              if (!foundMeasurement) {
                isValid = false;
                validationError = `Measurement title not found in goal '${goalTitle}': ${measurementTitle}`;
                console.error(validationError);
              }
            }
          }
        }

    if (!analysis.actionRequired) {
      console.log("No relevant action identified.");
    }

        // Only create a new event if there was a clear action and the LLM response is valid
        if (analysis.actionRequired) {
    // Create new event ~10ms after the original
    const newEventTime = new Date(new Date(eventData.time).getTime() + 10);
          const activity_id = uuidv4();

          const newEvent = {
      type: "plan_update_suggestion",
      content: analysis.description,
      inbound: false,
      time: newEventTime.toISOString(),
            relatedEventId: eventId,
            activity_id,
            api_call: apiCall,
            llm_response_valid: isValid,
            llm_validation_error: validationError
          };

          console.log('[analyzeMessageEvent] Creating plan_update_suggestion event:', JSON.stringify(newEvent));
          await admin.firestore().collection(`clients2/${clientId}/events`).add(newEvent);
          console.log("Created plan_update_suggestion event.");
          createdEvents.push(newEvent);
        } else {
          console.log("No clear action or invalid LLM response. No event created.");
        }
      }
    }

    // --- 2. Draft Reply Suggestion ---
    // Use generateCoachMessage from helpers
    const draftReply = await generateCoachMessage({ userId: clientId, toneParam: "" });
    console.log('[analyzeMessageEvent] Generated draft reply:', draftReply);

    // Delete any existing draft_reply_suggestion events for this client
    const draftReplyEventsSnap = await admin.firestore()
      .collection(`clients2/${clientId}/events`)
      .where('type', '==', 'draft_reply_suggestion')
      .get();
    const batch = admin.firestore().batch();
    draftReplyEventsSnap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Add new draft_reply_suggestion event
    const newDraftReplyEvent = {
      type: "draft_reply_suggestion",
      content: draftReply,
      inbound: false,
      time: new Date().toISOString(),
      relatedEventId: eventId,
      activity_id: uuidv4(),
    };
    await admin.firestore().collection(`clients2/${clientId}/events`).add(newDraftReplyEvent);
    createdEvents.push(newDraftReplyEvent);
    return createdEvents;
  });
