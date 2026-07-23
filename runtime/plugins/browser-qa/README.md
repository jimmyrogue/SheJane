# Browser QA plugin

Browser QA is a fixed first-party host adapter backed by Playwright 1.61.1 and its
matching Chromium 1228 build. The small plugin package contains schemas, instructions,
the bridge, and Playwright code; Chromium lives in a separate content-addressed Runtime
Asset so the plugin stays below the 64 MiB package limit.

It uses an isolated SheJane profile, routes destinations through the Runtime's
public-address-pinning proxy, and exposes only bounded open, observe, act, inspect, and
close Actions. The model cannot run arbitrary JavaScript, read cookies, enter
passwords, install extensions, or connect to the user's normal Chrome profile.
