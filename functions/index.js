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

    // Fetch plan data
    const plansSnapshot = await admin.firestore()
      .collection(`clients2/${clientId}/plans`)
      .get();
    const plans = plansSnapshot.docs.map(doc => doc.data());

    // LLM Prompt (optimized)
    const prompt = `
SYSTEM: You help fitness coaches track progress from client messages.
Given recent messages and the client's plan, determine if the most recent message implies any completed tactic or measurable change.

MESSAGES (latest first): ${JSON.stringify(recentMessages)}
CLIENT PLAN: ${JSON.stringify(plans)}

If the message implies a plan update, provide:
- A concise, human-readable instruction for the coach (description)
- An API call (method, path, body) for the plan change, following the REST API documented below.

If there's nothing relevant, say "No relevant progress identified." and set api_call to null.

REST API DOCS (for plan updates):

1. Mark Tactic Completion
POST /plans/{planId}/tactics/{tacticId}/completions
Body:
{
  "timestamp": "2025-07-03T18:00:00Z",
  "sourceEvent": "event_uuid"
}

2. Log Measurement
POST /plans/{planId}/measurements/{measurementId}/logs
Body:
{
  "date": "2025-07-05",
  "value": 210,
  "sourceEvent": "event_uuid"
}

3. Update Plan Metadata (optional)
PUT /plans/{planId}
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
  "api_call": {
    "method": "POST",
    "path": "/plans/{planId}/tactics/{tacticId}/completions",
    "body": { ... }
  } | null
}
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'system', content: prompt }],
      response_format: { type: "json_object" },
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    if (!analysis.actionRequired) {
      console.log("No relevant action identified.");
      return null;
    }

    // Create new event ~10ms after the original
    const newEventTime = new Date(new Date(eventData.time).getTime() + 10);
    const activity_id = uuidv4();

    const newEvent = {
      type: "plan_update_suggestion",
      content: analysis.description,
      inbound: false,
      time: newEventTime.toISOString(),
      relatedEventId: eventId,
      activity_id
    };
    if (analysis.api_call) {
      newEvent.api_call = analysis.api_call;
    }

    await admin.firestore().collection(`clients2/${clientId}/events`).add(newEvent);

    console.log("Created plan_update_suggestion event.");
  });
