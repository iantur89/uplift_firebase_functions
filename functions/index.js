const functions = require('firebase-functions'); // 1st gen import
const admin = require('firebase-admin');
const { OpenAI } = require('openai');

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

    // LLM Prompt
    const prompt = `
      SYSTEM: You help fitness coaches track progress from client messages.
      Given recent messages and the client's plan, determine if the most recent message implies any completed tactic or measurable change.

      MESSAGES (latest first): ${JSON.stringify(recentMessages)}
      CLIENT PLAN: ${JSON.stringify(plans)}

      Provide concise, human-readable instructions for updating the plan. If there's nothing relevant, say "No relevant progress identified."

      RESPOND IN JSON FORMAT:
      {
        "actionRequired": true|false,
        "description": "<instruction or summary>"
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

    await admin.firestore().collection(`clients2/${clientId}/events`).add({
      type: "plan_update_suggestion",
      content: analysis.description,
      inbound: false,
      time: newEventTime.toISOString(),
      relatedEventId: eventId
    });

    console.log("Created suggestion event.");
  });
