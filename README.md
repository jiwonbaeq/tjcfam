# TJC Fam calendar

Side-by-side day / week / month calendar for you and your reports, synced both ways with Google Calendar.
It lives at **https://www.jiwonbaeq.com/fam** and can be signed in to several Google accounts at once
(e.g. `jiwon@thisjanuary.com` for your lane, `jiwonbaeq@gmail.com` for Rishi's and Sasha's).

```
public/fam/index.html        the calendar page
netlify/functions/api.mjs    Google sign-in + calendar access (one serverless function, no packages)
netlify.toml                 Netlify build settings
```

How it's wired: this project is its own Netlify site. Your portfolio site forwards everything under `/fam`
to it, so your portfolio's code doesn't change apart from one forwarding rule.
Google sign-ins are kept in an encrypted, HttpOnly cookie, so the page itself never sees your Google keys.
Lane names, colours and which calendar goes in which lane are saved in your browser.

Setup takes about 20 minutes, once. Do the steps in order.

---

## 1. Put this project on GitHub

Create a new **private** repository (e.g. `tjcfam`) and upload these files to it, keeping the folder structure.
(GitHub's web page → *Add file → Upload files* works; drag the whole unzipped folder in.)

## 2. Create the Netlify site

1. Netlify → **Add new site → Import an existing project → GitHub** → pick `tjcfam`.
2. Leave the build settings as they are (they come from `netlify.toml`) and click **Deploy**.
3. Note the site's address, something like `https://tjcfam-1234.netlify.app`. You'll need it in step 5.
   (Optional: Site configuration → Change site name → `tjcfam`, giving `https://tjcfam.netlify.app`.)

## 3. Google Cloud: allow the site to use Google Calendar

1. Go to **https://console.cloud.google.com**, signed in as either account. Create a project called **TJC Fam**.
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **Google Auth Platform** (or *OAuth consent screen*) → **Get started**:
   - App name: `TJC Fam` · Support email: yours.
   - Audience: **External** (needed so both your work and Gmail accounts can sign in).
   - Contact email: yours → Create.
4. **Data access → Add or remove scopes** → add `.../auth/calendar` (*See, edit, share and permanently delete all the calendars…*).
   `openid` and `email` are included automatically. Save.
5. **Audience → Test users** → add `jiwon@thisjanuary.com` and `jiwonbaeq@gmail.com`.
6. **Clients → Create client**:
   - Application type: **Web application** · Name: `TJC Fam site`
   - Authorized redirect URIs → **Add URI** → `https://www.jiwonbaeq.com/fam/api/auth/callback`
   - Create, then copy the **Client ID** and **Client secret**.

**Stay signed in for good:** while the app is in *Testing*, Google signs you out of it every 7 days.
To stop that, go to **Audience → Publish app**. Because the app isn't verified by Google, the sign-in screen will show
"Google hasn't verified this app": click **Advanced → Go to TJC Fam (unsafe)**. That warning is about Google's review,
not about the site, and only you will ever see it. You don't need to submit it for verification for personal use.

**If your work account is blocked:** a Google Workspace admin for thisjanuary.com can stop outside apps from reaching
work calendars. If signing in as `jiwon@thisjanuary.com` says access is blocked, ask the admin to allow the app:
Admin console → **Security → Access and data control → API controls → Manage third-party app access →
Configure new app** → paste the Client ID → **Trusted**.

## 4. Netlify: add the settings the function needs

Netlify → your `tjcfam` site → **Site configuration → Environment variables → Add a variable**, one per row:

| Key | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the Client ID from step 3 |
| `GOOGLE_CLIENT_SECRET` | the Client secret from step 3 |
| `SESSION_SECRET` | a long random string, e.g. from https://www.random.org/strings (40 characters, letters + digits) |
| `PUBLIC_URL` | `https://www.jiwonbaeq.com/fam` |
| `ALLOWED_EMAILS` | `jiwon@thisjanuary.com,jiwonbaeq@gmail.com` (only these accounts can sign in) |

Then **Deploys → Trigger deploy → Deploy site** so the function picks them up.

## 5. Portfolio: forward /fam to the new site

In your **portfolio's** repository, add these two rules. Replace `tjcfam.netlify.app` with the address from step 2.

If the portfolio has a `netlify.toml`, add this near the top, **above** any catch-all `from = "/*"` rule:

```toml
[[redirects]]
  from = "/fam/*"
  to = "https://tjcfam.netlify.app/fam/:splat"
  status = 200
  force = true

[[redirects]]
  from = "/fam"
  to = "https://tjcfam.netlify.app/fam/"
  status = 200
  force = true
```

Or, if it uses a `_redirects` file instead (in the folder that gets published), put these lines **first**:

```
/fam/*  https://tjcfam.netlify.app/fam/:splat  200!
/fam    https://tjcfam.netlify.app/fam/        200!
```

Commit; Netlify redeploys the portfolio automatically.

## 6. Sign in

Open **https://www.jiwonbaeq.com/fam** → ⚙ Settings → **Sign in with Google** → choose `jiwon@thisjanuary.com`.
Then **+ Add another Google account** → choose `jiwonbaeq@gmail.com`.
Under **Team**, pick each person's calendar. The list is grouped by account, so your lane can use *TJC Jiwon* from the
work account while Rishi's and Sasha's use *Rishi TJC* and *Sasha TJC* from Gmail.

You're signed in per browser: on a new computer or phone, open the page and sign in once there too.

---

## Changing things later

Edit the files on GitHub (or ask Claude to); every commit to `main` redeploys automatically.

## Troubleshooting

- **"The site's Google sign-in isn't set up yet"**: an environment variable from step 4 is missing; add it and redeploy.
- **Google says `redirect_uri_mismatch`**: the redirect URI in step 3.6 must be exactly
  `https://www.jiwonbaeq.com/fam/api/auth/callback`, and `PUBLIC_URL` exactly `https://www.jiwonbaeq.com/fam`.
- **"That Google account isn't allowed on this site"**: add it to `ALLOWED_EMAILS` (and to Test users if the app is in Testing).
- **An account shows "Needs to sign in again"**: click **Sign in again** next to it (expected weekly while the app is in Testing).
- **/fam shows your portfolio's 404**: the forwarding rule in step 5 sits below a catch-all rule; move it to the top.
