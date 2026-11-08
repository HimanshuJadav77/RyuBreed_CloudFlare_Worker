import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FirestoreClient } from '../worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = {};
fs.readFileSync(path.resolve(__dirname, '../.dev.vars'), 'utf8').split('\n').forEach((l) => {
  const idx = l.indexOf('=');
  if (idx !== -1) {
    let v = l.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[l.slice(0, idx).trim()] = v;
  }
});

const firestore = new FirestoreClient(env);

async function check() {
  const list = await firestore.runQuery('institutes', [], 50);
  console.log(`Found ${list.length} institute(s):`);
  for (const i of list) {
    const id = i.id || i._id;
    const settingsFcm = await firestore.getDocument(`institutes/${id}/settings/fcm`);
    console.log(`- ID: ${id}`);
    console.log(`  Name: ${i.name || 'Unnamed'}`);
    console.log(`  Email: ${i.email || 'None'}`);
    console.log(`  Status: ${i.subscriptionStatus || 'None'}`);
    console.log(`  Root FCM Token: ${Boolean(i.fcmToken)}`);
    console.log(`  Settings FCM Token: ${Boolean(settingsFcm?.fcmToken)}`);
    if (i.fcmToken || settingsFcm?.fcmToken) {
      console.log(`  Token Snippet: ${(i.fcmToken || settingsFcm.fcmToken).slice(0, 30)}...`);
    }
  }
}

check().catch(console.error);
