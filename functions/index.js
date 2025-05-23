const functions = require('firebase-functions'); // 1st gen import
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');

admin.initializeApp();

const openai = new OpenAI({ 
  apiKey: functions.config().openai.api_key 
});

exports.analyzeMessageEvent = functions.firestore
  .document('clients2/{clientId}/events/{eventId}')
  .onCreate(async (snap, context) => {
    const { clientId, eventId } = context.params;
    const eventData = snap.data();

    console.log(`[analyzeMessageEvent] Triggered for clientId: ${clientId}, eventId: ${eventId}`);
    console.log('[analyzeMessageEvent] eventData:', JSON.stringify(eventData));

    // Skip if it's not an inbound message
    if (eventData.type !== "message" || eventData.inbound === false) {
      console.log("Not an inbound client message. Skipping.");
      return null;
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
      // LLM Prompt (updated for RESTful path and payload)
      const planUpdatePrompt = `
SYSTEM: You help fitness coaches track progress from client messages.
Given recent messages and the client's plan, determine if the most recent message implies any completed tactic or measurable change.

MESSAGES (latest first): ${JSON.stringify(recentMessages)}
CLIENT PLAN: ${JSON.stringify(plans)}

If the message implies a plan update, provide:
- A concise, human-readable instruction for the coach (description)
- The full REST API path (including userId and planId) for the plan change, following the API documented below.
- The JSON payload (body) for the API call, as a separate key.

If there's nothing relevant, say "No relevant progress identified." and set api_call to null.

REST API DOCS (for plan updates):

1. Mark Tactic Completion
POST /clients2/{userId}/plans/{planId}/tactics/{tacticId}/completions
Body:
{
  "timestamp": "2025-07-03T18:00:00Z",
  "sourceEvent": "event_uuid"
}

2. Log Measurement
POST /clients2/{userId}/plans/{planId}/measurements/{measurementId}/logs
Body:
{
  "date": "2025-07-05",
  "value": 210,
  "sourceEvent": "event_uuid"
}

3. Update Plan Metadata (optional)
PUT /clients2/{userId}/plans/{planId}
Body:
{
  "title": "Updated Plan Title",
  "start_date": "2025-07-01",
  "end_date": "2025-09-23"
}

Only suggest an API call if the message clearly implies a plan update, tactic completion, or measurement log.

RESPOND IN JSON FORMAT:
{
  "actionRequired": true|false,
  "description": "<instruction or summary>",
  "api_path": "/clients2/{userId}/plans/{planId}/tactics/{tacticId}/completions",
  "api_payload": { ... },
  "api_call": {
    "method": "POST",
    "path": "/clients2/{userId}/plans/{planId}/tactics/{tacticId}/completions",
    "body": { ... }
  } | null
}

Make sure api_path and api_payload are always present and correct if actionRequired is true.
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
      }

      if (!analysis.actionRequired) {
        console.log("No relevant action identified.");
        return null;
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
          api_path: apiPath,
          api_payload: apiPayload,
          api_call: apiCall,
          llm_response_valid: isValid,
          llm_validation_error: validationError
        };

        console.log('[analyzeMessageEvent] Creating plan_update_suggestion event:', JSON.stringify(newEvent));
        await admin.firestore().collection(`clients2/${clientId}/events`).add(newEvent);
        console.log("Created plan_update_suggestion event.");
        return newEvent;
      } else {
        console.log("No clear action or invalid LLM response. No event created.");
        return null;
      }
    }

    // --- 2. Draft Reply Suggestion ---
    // Compose LLM prompt for draft reply
    const draftReplyPrompt = `
SYSTEM: You help fitness coaches draft replies to client messages.
Given the most recent inbound message, provide a draft reply.

MESSAGE: ${JSON.stringify(recentMessages[0])}

RESPOND IN JSON FORMAT:
{
  "content": "<draft reply content>"
}
`;

    console.log('[analyzeMessageEvent] LLM prompt:', draftReplyPrompt);

    const draftReplyResponse = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'system', content: draftReplyPrompt }],
      response_format: { type: "json_object" },
    });

    console.log('[analyzeMessageEvent] LLM raw response:', JSON.stringify(draftReplyResponse));

    let draftReply;
    try {
      draftReply = JSON.parse(draftReplyResponse.choices[0].message.content);
      console.log('[analyzeMessageEvent] Parsed LLM draft reply:', JSON.stringify(draftReply));
    } catch (err) {
      console.error("Failed to parse LLM response:", draftReplyResponse.choices[0].message.content);
      throw err;
    }

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
      content: draftReply.content,
      inbound: false,
      time: new Date().toISOString(),
      relatedEventId: eventId,
      activity_id: uuidv4(),
    };
    await admin.firestore().collection(`clients2/${clientId}/events`).add(newDraftReplyEvent);

    return null;
  });
