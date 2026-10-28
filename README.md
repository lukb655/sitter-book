# Sitter Book

A phone web app for tracking babysitting families (active and on-call), shifts, clock in/out hours and pay. Data is stored in Firebase Firestore so it syncs live between both phones, and shifts can go onto Google Calendar.

## How it fits together

- **GitHub Pages** hosts the files (`index.html`, `app.js`, …). It's just a website.
- **Firebase Authentication** handles "Sign in with Google".
- **Firestore** stores the data under `/sitter/main/...`. Both phones listen to it, so a change on one shows up on the other within a second or two. It also caches offline and uploads when back online.
- **firestore.rules** is the lock on the door: only the Gmail addresses listed there can read or write.
- **Google Calendar** (optional auto-sync) uses Google's Calendar API with the same Google account.

## Setup

### 1. Firebase project
1. Firebase console → **Add project** (or use an existing one). Analytics is optional.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**. Pick a support email and save.
3. **Authentication → Settings → Authorized domains → Add domain**: `YOURUSER.github.io`
4. **Build → Firestore Database → Create database**. Choose a location near you (e.g. `us-east1`) and start in **production mode**.
5. **Firestore → Rules**: paste the contents of `firestore.rules`, replace the two emails with hers and yours (lowercase), and **Publish**.
6. **Project settings (gear) → General → Your apps → Web (`</>`)**. Register an app called "Sitter Book" (skip Hosting). Copy the `firebaseConfig` values into `firebase-config.js`.

### 2. GitHub Pages
1. Commit the edited `firebase-config.js`.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
3. After a minute the app is at `https://YOURUSER.github.io/sitter-book/`.

### 3. Optional: automatic Google Calendar sync
Without this, every shift has an "Add to Google Calendar" button that opens Google Calendar pre-filled and invites the people in Calendar settings.

1. Open [Google Cloud console](https://console.cloud.google.com/) and select the same project as Firebase.
2. **APIs & Services → Library → Google Calendar API → Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): user type **External**, app name "Sitter Book", your email. Under **Data access / Scopes** add `.../auth/calendar.events`. Under **Audience → Test users** add her Gmail and yours. Leave it in **Testing**.
4. **APIs & Services → Credentials** → open **Web client (auto created by Google Service)** → **Authorized JavaScript origins → Add URI** `https://YOURUSER.github.io` → Save.
5. Copy that client's **Client ID** into `GOOGLE_CLIENT_ID` in `firebase-config.js` and commit.
6. In the app: **Schedule → Calendar settings → Connect Google Calendar**. Google will warn the app is unverified; tap **Continue** (it's your own app in testing mode).

With sync on, shifts saved on that phone are created, moved and deleted on that person's Google Calendar, and everyone in "Invite to every shift" gets the invite.

### 4. Put it on the home screen
- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** ⋮ → Add to Home screen.

## Notes
- The Firebase config values in `firebase-config.js` are meant to be public. Security comes from `firestore.rules`.
- To give someone else access, add their Gmail to `firestore.rules` and publish the rules.
- Firestore's free tier is far more than this app will use.
