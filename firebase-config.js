// Paste your Firebase web app config here (Firebase console → Project settings → Your apps → SDK setup and configuration → Config).
// These values are not secrets; access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// Optional: turns on automatic Google Calendar sync.
// Google Cloud console → APIs & Services → Credentials → "Web client (auto created by Google Service)" → Client ID.
// Leave as "" to use the "Add to Google Calendar" buttons instead.
export const GOOGLE_CLIENT_ID = "";
