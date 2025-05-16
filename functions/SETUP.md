### `SETUP.txt`

# Uplift Firebase Function Setup

This file documents how to set up and deploy the `analyzeMessageEvent` Cloud Function for the Uplift project.

---

## 🔧 Prerequisites

* Node.js version **18.x** (avoid 22+ for now)
* Firebase CLI installed (`npm install -g firebase-tools`)
* Google Cloud SDK (for advanced role fixes): `brew install --cask google-cloud-sdk`
* Project must be on **Blaze Plan**

---

## 📁 Project Structure

```
uplift/
└── functions/
    ├── index.js
    ├── package.json
    └── package-lock.json
```

---

## 🔐 Service Account Setup (One-Time Only)

### Add IAM roles manually (in Google Cloud Console):

1. **Cloud Functions Service Agent**
   `service-<PROJECT_NUMBER>@gcf-admin-robot.iam.gserviceaccount.com`
   → Add roles:

   * `Cloud Functions Admin`
   * `Service Account User`
   * `Cloud Build Editor`

2. **Eventarc Service Agent** (for 2nd-gen fallback)
   Add using CLI:

   ```bash
   gcloud projects add-iam-policy-binding uplift-17bea \
     --member="serviceAccount:service-453342728970@eventarc.gserviceaccount.com" \
     --role="roles/eventarc.serviceAgent"
   ```

---

## 🔑 Environment Variables

### Local Development
Create a `.env` file in the `functions` directory:
```bash
echo "OPENAI_API_KEY=your_api_key_here" > .env
```

Add `.env` to `.gitignore`:
```bash
echo ".env" >> .gitignore
```

### Firebase Deployment
Set the API key in Firebase config:
```bash
firebase functions:config:set openai.api_key="your_api_key_here"
```

The function will use `functions.config().openai.api_key` to access this value.

---

## 📦 `package.json`

Pin versions to avoid v2 syntax conflicts:

```json
"firebase-functions": "^3.24.1",
"firebase-functions-test": "^2.4.0",
"firebase-admin": "^11.11.1",
"openai": "^4.0.0"
```

```json
"engines": {
  "node": "18"
}
```

---

## 🧹 Clean Install

```bash
cd functions
rm -rf node_modules package-lock.json
npm install
```

---

## 🧠 Function Code (index.js)

Ensure your `functions/index.js` uses **v1-style syntax**:

```js
const functions = require('firebase-functions');
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

    if (eventData.type !== "message" || eventData.inbound === false) {
      console.log("Not an inbound client message. Skipping.");
      return null;
    }

    const recentMessagesSnapshot = await admin.firestore()
      .collection(`clients2/${clientId}/events`)
      .orderBy('time', 'desc')
      .limit(5)
      .get();

    const recentMessages = recentMessagesSnapshot.docs.map(doc => doc.data());

    const plansSnapshot = await admin.firestore()
      .collection(`clients2/${clientId}/plans`)
      .get();
    const plans = plansSnapshot.docs.map(doc => doc.data());

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
```

---

## 🚀 Deploy Function

From project root:

```bash
firebase deploy --only functions
```

If needed:

```bash
firebase functions:delete analyzeMessageEvent --region=us-central1
```

---

## 📜 View Logs

* Firebase Console → Functions → analyzeMessageEvent → **View logs**
* Or via CLI:

```bash
firebase functions:log --only analyzeMessageEvent
```

---

Let me know if you want this as a downloadable file or zipped repo.
