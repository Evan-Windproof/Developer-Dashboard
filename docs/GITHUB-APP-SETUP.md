# Create a GitHub App

Create a development GitHub App for `http://localhost:8788` and a separate production GitHub App for your HTTPS deployment. Use the exact, stable origin in all fields.

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**. For an organization-owned App, use its organization settings.
2. Choose a unique **GitHub App name** and set **Homepage URL** to the dashboard origin.
3. Set **Callback URL** to `<APP_BASE_URL>/api/auth/github/callback`. The dashboard starts its own GitHub App user authorization flow. Leave **Request user authorization (OAuth) during installation** unchecked.
4. Leave **Expire user authorization tokens** checked. The dashboard supports refresh tokens and handles reconnect when GitHub requires sign-in again.
5. In **Post installation**, set **Setup URL** to `<APP_BASE_URL>/api/github/installation/callback`. Enable **Redirect on update** if you want GitHub to send users back after changing repository selection. Updates initiated directly on GitHub have no dashboard state. Use **Sync Repositories** from the dashboard to pick up those changes.
6. Under **Webhook**, clear **Active**.
7. Under **Repository permissions**, keep **Metadata** at **Read-only**. Leave Contents, Administration, and other write permissions unset. Leave organization and account permissions unset.
8. Choose **Any account** under **Where can this GitHub App be installed?**. Create the App.
9. On the App's settings page, copy **App ID**, **Client ID**, and the slug from the App URL. Generate a new **client secret** and a **private key**. Configure them as directed in the [README](../README.md#configuration).
10. Open the dashboard and select **Continue with GitHub**. Choose **Install GitHub App** and select your personal account or organization and specific repositories. Complete the callback, then select **Sync Repositories**. If an admin must approve the request, sync after approval. Existing installations can be discovered directly by sync.

Changing the dashboard origin requires updating both GitHub URLs and `APP_BASE_URL`. Use the configured origin when testing, since session and state cookies belong to that host.

[GitHub's App registration documentation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
