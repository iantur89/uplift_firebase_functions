const test = require('firebase-functions-test')();

const { v4: uuidv4 } = require('uuid');

// Only mock Firebase Functions config, not firestore
jest.mock('firebase-functions', () => {
  const original = jest.requireActual('firebase-functions');
  return {
    ...original,
    config: () => ({
      openai: {
        api_key: 'test-api-key'
      }
    })
  };
});

// Mock the OpenAI client
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                actionRequired: true,
                description: "Client completed their workout",
                api_path: "/clients2/client123/plans/plan-123/tactics/workout/completions",
                api_payload: {
                  timestamp: "2024-03-20T10:00:00Z",
                  sourceEvent: "event-123"
                },
                api_call: {
                  method: "POST",
                  path: "/clients2/client123/plans/plan-123/tactics/workout/completions",
                  body: {
                    timestamp: "2024-03-20T10:00:00Z",
                    sourceEvent: "event-123"
                  }
                }
              })
            }
          }]
        })
      }
    }
  }))
}));

describe('analyzeMessageEvent', () => {
  let adminInitStub;
  let wrapped;
  let mockFirestoreStub;
  let admin;

  beforeAll(() => {
    // Now mock firebase-admin
    jest.mock('firebase-admin', () => {
      mockFirestoreStub = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn(),
        add: jest.fn()
      };
      return {
        initializeApp: jest.fn(),
        firestore: jest.fn(() => mockFirestoreStub)
      };
    });
    admin = require('firebase-admin');
    adminInitStub = jest.spyOn(admin, 'initializeApp');
    const myFunctions = require('./index');
    wrapped = test.wrap(myFunctions.analyzeMessageEvent);
  });

  afterAll(() => {
    test.cleanup();
    adminInitStub.mockRestore();
  });

  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  it('should skip non-inbound message events', async () => {
    const data = {
      type: 'message',
      inbound: false,
      time: new Date().toISOString()
    };
    const snap = test.firestore.makeDocumentSnapshot(data, 'clients2/client123/events/event123');

    const context = {
      params: {
        clientId: 'client123',
        eventId: 'event123'
      }
    };

    await wrapped(snap, context);
    expect(mockFirestoreStub.add).not.toHaveBeenCalled();
  });

  it('should process inbound message and create plan update suggestion', async () => {
    // Mock recent messages
    const recentMessages = [
      { type: 'message', inbound: true, content: 'I completed my workout today!' }
    ];
    mockFirestoreStub.get.mockResolvedValueOnce({
      docs: recentMessages.map(msg => ({
        data: () => msg
      }))
    });

    // Mock plans
    const plans = [{
      planId: 'plan-123',
      goals: [{
        tactics: [{ title: 'Complete workout' }]
      }]
    }];
    mockFirestoreStub.get.mockResolvedValueOnce({
      docs: plans.map(plan => ({
        data: () => plan
      }))
    });

    // Mock the new event creation
    mockFirestoreStub.add.mockResolvedValueOnce({ id: 'new-event-123' });

    const data = {
      type: 'message',
      inbound: true,
      content: 'I completed my workout today!',
      time: new Date().toISOString()
    };
    const snap = test.firestore.makeDocumentSnapshot(data, 'clients2/client123/events/event123');

    const context = {
      params: {
        clientId: 'client123',
        eventId: 'event123'
      }
    };

    await wrapped(snap, context);

    // Verify that a new event was created
    expect(mockFirestoreStub.add).toHaveBeenCalledWith(expect.objectContaining({
      type: 'plan_update_suggestion',
      inbound: false,
      relatedEventId: 'event123'
    }));
  });

  it('should handle OpenAI API errors gracefully', async () => {
    // Mock Firestore .get() to return expected structure
    mockFirestoreStub.get
      .mockResolvedValueOnce({ docs: [] }) // recentMessages
      .mockResolvedValueOnce({ docs: [] }); // plans

    // Mock OpenAI to throw an error
    const { OpenAI } = require('openai');
    OpenAI.mockImplementationOnce(() => ({
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error('API Error'))
        }
      }
    }));

    const data = {
      type: 'message',
      inbound: true,
      content: 'I completed my workout today!',
      time: new Date().toISOString()
    };
    const snap = test.firestore.makeDocumentSnapshot(data, 'clients2/client123/events/event123');

    const context = {
      params: {
        clientId: 'client123',
        eventId: 'event123'
      }
    };

    try {
      await wrapped(snap, context);
    } catch (err) {
      expect(err.message).toBe('API Error');
    }
  });

  it('should handle missing plan data gracefully', async () => {
    // Mock recent messages
    const recentMessages = [
      { type: 'message', inbound: true, content: 'I completed my workout today!' }
    ];
    mockFirestoreStub.get.mockResolvedValueOnce({
      docs: recentMessages.map(msg => ({
        data: () => msg
      }))
    });

    // Mock empty plans
    mockFirestoreStub.get.mockResolvedValueOnce({
      docs: []
    });

    const data = {
      type: 'message',
      inbound: true,
      content: 'I completed my workout today!',
      time: new Date().toISOString()
    };
    const snap = test.firestore.makeDocumentSnapshot(data, 'clients2/client123/events/event123');

    const context = {
      params: {
        clientId: 'client123',
        eventId: 'event123'
      }
    };

    await wrapped(snap, context);
    expect(mockFirestoreStub.add).toHaveBeenCalled();
  });
}); 