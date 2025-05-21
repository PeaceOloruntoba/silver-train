import admin from "firebase-admin";

const serviceAccount = (
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

export const db = admin.firestore();
