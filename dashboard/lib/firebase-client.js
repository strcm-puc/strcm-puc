import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// Public web config only — apiKey/appId etc. are not secrets, they identify
// the Firebase project to the client SDK; actual access is gated by Firestore
// Security Rules (see /firestore.rules at the repo root), never by a service
// account. Never import firebase-admin or ../../firebase-config from this app.
const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function getDb() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getFirestore(app);
}
