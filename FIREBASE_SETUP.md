# Firebase Setup Guide for The Speaker's Gym

This guide will help you set up Firebase authentication and cloud sync for your Speaker's Gym app.

## Step 1: Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **"Add project"** or select your existing project: "Speaker's Gym Premium"
3. Follow the setup wizard (you can disable Google Analytics if not needed)

## Step 2: Register Your Web App

1. In your Firebase project, click the **Web icon (</>) **to add a web app
2. Give it a nickname: "Speaker's Gym Web"
3. Check **"Also set up Firebase Hosting"** (optional, if you want to host on Firebase)
4. Click **"Register app"**
5. You'll see your Firebase configuration object - **COPY THIS**

It will look like:
```javascript
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "speakers-gym-premium.firebaseapp.com",
  projectId: "speakers-gym-premium",
  storageBucket: "speakers-gym-premium.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef1234567890"
};
```

## Step 3: Add Configuration to Your App

1. Open `index.html`
2. Find line 2006-2013 (search for `const firebaseConfig`)
3. **Replace the placeholder values** with your actual Firebase config:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_ACTUAL_API_KEY",           // Replace this
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",  // Replace this
  projectId: "YOUR_ACTUAL_PROJECT_ID",     // Replace this
  storageBucket: "YOUR_PROJECT_ID.appspot.com",  // Replace this
  messagingSenderId: "YOUR_SENDER_ID",     // Replace this
  appId: "YOUR_APP_ID"                     // Replace this
};
```

## Step 4: Enable Google Authentication

1. In Firebase Console, go to **Authentication** → **Sign-in method**
2. Click **Google**
3. Toggle **Enable**
4. Add your support email (required)
5. Click **Save**

## Step 5: Set Up Firestore Database

1. In Firebase Console, go to **Firestore Database**
2. Click **Create database**
3. Choose **"Start in production mode"** (we'll add rules next)
4. Select a location (choose closest to your users)
5. Click **Enable**

## Step 6: Configure Firestore Security Rules

1. In Firestore, go to the **Rules** tab
2. Replace the default rules with these secure rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read/write their own data
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      // Speeches subcollection
      match /speeches/{speechId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

3. Click **Publish**

### What These Rules Do:
- ✅ Users must be authenticated to access any data
- ✅ Users can only access their OWN data (not others')
- ✅ Each user's speeches are in their own private subcollection
- ❌ Prevents unauthorized access
- ❌ Prevents users from seeing other users' data

## Step 7: Deploy Your App

1. Commit and push your changes to GitHub
2. Deploy to Vercel (or your hosting platform)
3. The Firebase configuration will be included in the deployed app

## Step 8: Test the Setup

### Test Sign-In:
1. Open your deployed app
2. You should see **"☁️ Cloud Sync"** section at the top
3. Click **"Sign in with Google"**
4. Choose your Google account
5. Grant permissions
6. You should see: **"Signed in as [your-email]"**
7. Status should show: **"Up to date"** with a green dot

### Test Data Sync:
1. Record a speech (with AI feedback enabled)
2. Watch the sync status change to **"Syncing..."** then **"Synced"**
3. Check Firebase Console → Firestore Database
4. You should see:
   - `users/{your-uid}/` document with your stats
   - `users/{your-uid}/speeches/` collection with your speech data

### Test Multi-Device Sync:
1. Open the app on your laptop (signed in)
2. Record a speech
3. Open the app on your phone (sign in with same account)
4. Your stats and speeches should appear automatically!
5. Record a speech on phone
6. Check laptop - should update in real-time

### Test Offline Mode:
1. Turn off WiFi/network
2. Record speeches - they'll save locally
3. Turn network back on
4. Data should sync automatically
5. Status will show **"Offline"** → **"Back online"** → **"Syncing..."** → **"Synced"**

## Firestore Data Structure

Your data will be organized like this:

```
users/
  {userId}/
    - stats: {
        todaySpeeches: 3,
        totalSpeeches: 45,
        streak: 7,
        ratings: [4, 5, 3, 4, 5],
        weekHistory: {...},
        lastDate: "2025-01-10"
      }
    - settings: {
        aiEnabled: true,
        notifications: {...}
      }
    - migrated: true
    - updatedAt: Timestamp

    speeches/
      {speechId}/
        - word: "Trust"
        - definition: "Firm belief in reliability"
        - duration: 120
        - transcript: "..."
        - feedback: "..."
        - rating: 4
        - createdAt: "2025-01-10T15:30:00Z"
        - mode: "audio"
        - userId: "{userId}"
        - syncedAt: Timestamp
```

## Cost Considerations

### Free Tier Limits (More than enough for personal use):
- **Authentication**: 50,000 monthly active users (free)
- **Firestore**:
  - 50,000 reads/day (free)
  - 20,000 writes/day (free)
  - 20,000 deletes/day (free)
  - 1 GB storage (free)

### Typical Usage:
- **Per speech**: ~3-5 writes (stats + speech + settings)
- **Loading app**: ~2-3 reads
- **Real-time updates**: Minimal additional reads

### Example:
- 3 speeches/day × 5 writes = 15 writes/day
- Loading app 5 times/day × 3 reads = 15 reads/day
- **Total monthly**: ~450 writes, ~450 reads
- **Well within free tier!** ✅

## Troubleshooting

### "Sign in failed" error:
- Check that Google authentication is enabled in Firebase Console
- Verify your domain is authorized (add to Authorized domains in Authentication settings)
- For localhost testing, make sure "localhost" is in authorized domains

### Data not syncing:
- Check browser console for errors (F12 → Console)
- Verify Firebase config is correct (no placeholder values)
- Check Firestore security rules are published
- Ensure you're signed in (check top of app)

### "Permission denied" in Firestore:
- Your security rules might be too restrictive
- Make sure you're signed in
- Verify the rules match the ones in Step 6

### Offline mode not working:
- Clear browser cache and reload
- Firestore persistence might be disabled (check console logs)
- Try different browser (some browsers block IndexedDB)

## Security Best Practices

✅ **DO**:
- Keep your Firebase API key in the code (it's safe for web apps)
- Use Firebase Security Rules to protect data
- Enable only the authentication providers you need
- Regularly review Firestore usage in Firebase Console

❌ **DON'T**:
- Share your service account keys (not needed for web apps)
- Make Firestore rules too permissive (`allow read, write: if true`)
- Store sensitive data without proper rules

## Firebase Console Links

Quick links for your project:
- **Console**: https://console.firebase.google.com/project/YOUR_PROJECT_ID
- **Authentication**: https://console.firebase.google.com/project/YOUR_PROJECT_ID/authentication/users
- **Firestore**: https://console.firebase.google.com/project/YOUR_PROJECT_ID/firestore/data
- **Usage**: https://console.firebase.google.com/project/YOUR_PROJECT_ID/usage

Replace `YOUR_PROJECT_ID` with your actual project ID (e.g., "speakers-gym-premium").

## Need Help?

- **Firebase Documentation**: https://firebase.google.com/docs/web/setup
- **Firestore Security Rules**: https://firebase.google.com/docs/firestore/security/get-started
- **Authentication Guide**: https://firebase.google.com/docs/auth/web/google-signin

---

**Questions?** Check the browser console (F12) for detailed error messages.
