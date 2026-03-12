# Google OAuth Setup Guide

## Error 403: access_denied - How to Fix

This error occurs because your Google OAuth app needs proper configuration. Follow these steps:

---

## Steps to Fix

### 1. Go to Google Cloud Console
Visit: https://console.cloud.google.com/

### 2. Select Your Project
Click on the project dropdown and select your project (or create a new one)

### 3. Enable Gmail API
- Go to **APIs & Services** > **Library**
- Search for "Gmail API"
- Click **Enable**

### 4. Configure OAuth Consent Screen
- Go to **APIs & Services** > **OAuth consent screen**
- Select **External** user type (or Internal if using Google Workspace)
- Click **Create**

**Fill in the form:**
- **App name:** InBox_IQ (or your app name)
- **User support email:** Your email
- **Developer contact email:** Your email
- Click **Save and Continue**

**Scopes (Next screen):**
- Click **Add or Remove Scopes**
- Add these scopes:
  - `.../auth/gmail.readonly`
  - `.../auth/userinfo.email`
  - `.../auth/userinfo.profile`
- Click **Update** > **Save and Continue**

**Test Users (Important!):**
- Click **Add Users**
- Add the Gmail address you want to test with
- Click **Add** > **Save and Continue**

### 5. Configure OAuth Credentials
- Go to **APIs & Services** > **Credentials**
- Find your OAuth 2.0 Client ID (or create a new one)
- Click on your client ID to edit

**Authorized redirect URIs:**
Add this exact URI:
```
http://localhost:8000/login/oauth2/code/google
```

- Click **Save**

### 6. Publishing Status

**Option A: Testing Mode (Easier for Development)**
- Your app stays in "Testing" mode
- Only test users you added can login
- **Add your Gmail to test users list** (Step 4)
- No verification needed

**Option B: Production Mode (For Public App)**
- Go to OAuth consent screen
- Click **Publish App**
- Google will require verification (takes time)
- Any Google user can login

---

## Quick Checklist

✅ Gmail API is enabled
✅ OAuth consent screen is configured
✅ Redirect URI: `http://localhost:8000/login/oauth2/code/google`
✅ Test users added (if in Testing mode)
✅ Scopes added: gmail.readonly, userinfo.email, userinfo.profile

---

## Test Your Setup

### 1. Start the server
```bash
npm start
# or
node server.js
```

### 2. Get login URL
```bash
curl http://localhost:8000/gmail/login
```

### 3. Open the `loginUrl` in your browser
- You should see Google login screen
- Login with a test user email
- Click "Allow"
- Server will automatically fetch emails

---

## Common Issues

### "This app isn't verified"
- Click **Advanced** > **Go to InBox_IQ (unsafe)**
- This occurs for apps in Testing mode
- Normal for development

### "access_denied"
- Make sure your email is in the test users list
- Check redirect URI matches exactly
- Ensure all scopes are added

### "redirect_uri_mismatch"
- Update redirect URI in Google Console to:
  `http://localhost:8000/login/oauth2/code/google`

---

## Production Deployment

When deploying to production (e.g., https://yourdomain.com):

1. Add production redirect URI:
   ```
   https://yourdomain.com/login/oauth2/code/google
   ```

2. Update .env:
   ```
   REDIRECT_URI=https://yourdomain.com/login/oauth2/code/google
   ```

3. Publish your app (verification required)

---

## Need Help?

Check the detailed guide:
https://developers.google.com/identity/protocols/oauth2/web-server
