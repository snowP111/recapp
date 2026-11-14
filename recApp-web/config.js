/* recApp – Verbindung zu Supabase.
   Beides findest du in Supabase unter Project Settings → API (bzw. „Connect“ → App Frameworks).
   URL und öffentlicher Schlüssel (sb_publishable_… bzw. anon) dürfen öffentlich sein:
   Deine Daten schützt der Login plus Row Level Security. Den geheimen Schlüssel (sb_secret_… / service_role) NIE hier eintragen! */
window.RECAPP_CONFIG = {
  url: "https://tsxrvjdkpkfvixtjhfod.supabase.co",
  key: "sb_publishable_oMar0hvqS4YXEEBXBv7mbQ_WiK7U8bZ",
};
