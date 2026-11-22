/**
 * THE UPDATE SWITCHBOARD
 * ----------------------
 * Edit this file and redeploy (or later, move it to a database with an
 * admin panel) and every installed app picks up the change on next
 * launch — no Play Store release, no rebuild.
 *
 * Use it to prompt (or force) an update when a new APK is released. A
 * published APK (POST /admin/apk) overrides the version fields here.
 */
module.exports = {
  latestVersionCode: 1,
  latestVersionName: "0.1.0",
  forceUpdateBelow: 0, // set to a versionCode to force-update older installs

  changelog: [
    "First internal build — chat with live AI",
  ],
};
