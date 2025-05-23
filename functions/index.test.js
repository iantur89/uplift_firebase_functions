const test = require('firebase-functions-test')();
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { analyzeMessageEvent } = require('./index');

// Test user data
const TEST_USER_ID = 'test-user-' + uuidv4();
const TEST_EVENT_ID = 'test-event-' + uuidv4();

// Helper to pause for Firestore triggers to complete
const sleep = ms => new Promise(res => setTimeout(res, ms));

describe('analyzeMessageEvent (integration)', () => {
  let wrapped;

  beforeAll(async () => {
    // Set up test data in Firestore
    const db = admin.firestore();
    await db.collection('clients2').doc(TEST_USER_ID).set({
      profile: {
        clientName: 'Test Client',
        coachingStyle: 'Therapist',
        goal: 'Lose Weight'
      },
      summary: {
        Status: 'Engaged',
        Summary: 'Client is doing well'
      }
    });

    // Set up test plan
    await db.collection('clients2').doc(TEST_USER_ID).collection('plans').add({
      planId: 'plan-' + uuidv4(),
      start_date: new Date(Date.now() - 24*60*60*1000), // yesterday
      end_date: new Date(Date.now() + 24*60*60*1000),   // tomorrow
      goals: [{
        title: 'Lose Weight',
        tactics: [{ title: 'Complete workout', tacticId: 'tactic-1' }]
      }]
    });

    const myFunctions = require('./index');
    wrapped = test.wrap(myFunctions.analyzeMessageEvent);
  });

  afterAll(async () => {
    // Clean up test data
    const db = admin.firestore();
    // Delete all events
    const eventsSnap = await db.collection('clients2').doc(TEST_USER_ID).collection('events').get();
    for (const doc of eventsSnap.docs) await doc.ref.delete();
    // Delete all plans
    const plansSnap = await db.collection('clients2').doc(TEST_USER_ID).collection('plans').get();
    for (const doc of plansSnap.docs) await doc.ref.delete();
    // Delete client
    await db.collection('clients2').doc(TEST_USER_ID).delete();
    test.cleanup();
  });

  it('should skip non-inbound message events', async () => {
    const db = admin.firestore();
    const data = {
      type: 'message',
      inbound: false,
      time: new Date().toISOString()
    };
    const snap = test.firestore.makeDocumentSnapshot(data, `clients2/${TEST_USER_ID}/events/${TEST_EVENT_ID}`);
    const context = {
      params: {
        clientId: TEST_USER_ID,
        eventId: TEST_EVENT_ID
      }
    };
    await wrapped(snap, context);
    await sleep(2000); // Wait for any triggers
    const events = await db.collection('clients2').doc(TEST_USER_ID).collection('events').get();
    expect(events.size).toBe(0);
  });

  it('should process inbound message and create plan update suggestion and draft reply', async () => {
    const db = admin.firestore();
    const data = {
      type: 'message',
      inbound: true,
      content: 'I completed my workout today!',
      time: new Date().toISOString()
    };
    const snap = test.firestore.makeDocumentSnapshot(data, `clients2/${TEST_USER_ID}/events/${TEST_EVENT_ID}`);
    const context = {
      params: {
        clientId: TEST_USER_ID,
        eventId: TEST_EVENT_ID
      }
    };
    await wrapped(snap, context);
    await sleep(10000); // Wait for triggers and LLM
    const events = await db.collection('clients2').doc(TEST_USER_ID).collection('events').get();
    const planUpdateEvents = events.docs.filter(doc => doc.data().type === 'plan_update_suggestion');
    const draftReplyEvents = events.docs.filter(doc => doc.data().type === 'draft_reply_suggestion');
    expect(planUpdateEvents.length).toBeGreaterThanOrEqual(1);
    expect(draftReplyEvents.length).toBeGreaterThanOrEqual(1);
    // Optionally, print the draft reply for manual inspection
    // console.log('Draft reply:', draftReplyEvents[0].data().content);
  });
}); 