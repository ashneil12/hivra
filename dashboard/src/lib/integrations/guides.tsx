import React from 'react';

const stepStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  marginBottom: 12,
  alignItems: 'flex-start',
};
const numStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: 'var(--ink-black)',
  color: 'var(--bg-surface)',
  fontSize: 11,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginTop: 1,
};
const noteStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '10px 12px',
  background: 'rgba(59,130,246,0.06)',
  border: '1px solid rgba(59,130,246,0.2)',
  borderRadius: 0,
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
  marginTop: 4,
};
const warnStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '10px 12px',
  background: 'rgba(251,191,36,0.06)',
  border: '1px solid rgba(251,191,36,0.3)',
  borderRadius: 0,
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
  marginTop: 4,
};

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <div style={stepStyle}>
    <span style={numStyle}>{n}</span>
    <span style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{children}</span>
  </div>
);

export const getGuideContent = (platform: string) => {
  switch (platform) {
    case 'Telegram':
      return (
        <div>
          <Step n={1}>Open Telegram and search for <strong>@BotFather</strong> — this is the official Telegram bot creator. Start a conversation.</Step>
          <Step n={2}>Send the command <code>/newbot</code>. BotFather will ask for a display name and then a unique username ending in <code>bot</code> (e.g. <code>my_hermes_bot</code>).</Step>
          <Step n={3}>Copy the <strong>HTTP API Token</strong> BotFather gives you (looks like <code>123456789:ABCdef...</code>). Keep it secret — anyone with this token can control your bot.</Step>
          <Step n={4}><strong>For group chats:</strong> Send <code>/setprivacy</code> to BotFather, select your bot, then click <strong>Disable</strong>. Without this, the bot only sees messages directed at it (@username or commands). After changing this setting, remove and re-add the bot to any existing groups.</Step>
          <Step n={5}><strong>To allow group access:</strong> Send <code>/mybots</code>, select your bot, go to <strong>Bot Settings → Allow Groups?</strong> and turn groups on.</Step>
          <div style={noteStyle}>
            💡 <span>If you want the bot to send messages proactively (not just reply), you also need to have a user send the bot <code>/start</code> first to initiate the chat session.</span>
          </div>
        </div>
      );

    case 'Discord':
      return (
        <div>
          <Step n={1}>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>Discord Developer Portal</a> and click <strong>New Application</strong>. Give it a name.</Step>
          <Step n={2}>In the left sidebar, click <strong>Bot</strong>. Click <strong>Reset Token</strong>, confirm, and copy the token shown. This is your bot&apos;s password — treat it like one.</Step>
          <Step n={3}><strong>Enable Privileged Intents</strong> — this is required for the bot to read messages. Still on the Bot tab, scroll down to <strong>Privileged Gateway Intents</strong> and enable all three: <strong>Presence Intent</strong>, <strong>Server Members Intent</strong>, and <strong>Message Content Intent</strong>. Without these, the bot will connect but receive empty message content.</Step>
          <Step n={4}><strong>Invite to Server:</strong> Instead of manually generating an OAuth link, simply copy your <strong>Application ID</strong>, paste it into the field below, and click the generated invite link. Hermes will auto-fill the correct permissions for you!</Step>
          <Step n={5}>Paste the bot token below and connect. Hermes will handle the rest of the setup automatically.</Step>
          <div style={warnStyle}>
            ⚠️ <span>If your bot is in 100+ servers, Discord requires additional verification before granting privileged intents. For personal/private use this is not an issue.</span>
          </div>
        </div>
      );

    case 'Slack':
      return (
        <div>
          <Step n={1}>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>api.slack.com/apps</a> and click <strong>Create New App → From scratch</strong>. Give it a name and select your workspace.</Step>
          <Step n={2}><strong>Enable Socket Mode:</strong> In the left sidebar go to <strong>Settings → Socket Mode</strong> and toggle it <strong>On</strong>. This lets the bot connect without needing a public webhook URL.</Step>
          <Step n={3}><strong>Generate App-Level Token:</strong> Go to <strong>Settings → Basic Information → App-Level Tokens</strong>. Click <strong>Generate Token and Scopes</strong>, give it a name, add the scope <code>connections:write</code>, and click Generate. Copy this token — it starts with <code>xapp-</code>.</Step>
          <Step n={4}><strong>Add Bot Scopes:</strong> Go to <strong>Features → OAuth &amp; Permissions → Bot Token Scopes</strong>. Add: <code>chat:write</code>, <code>app_mentions:read</code>, <code>channels:history</code>, <code>im:history</code>, <code>im:write</code>.</Step>
          <Step n={5}><strong>Install to Workspace:</strong> Still on OAuth &amp; Permissions, scroll up and click <strong>Install to Workspace</strong>. Approve it. Afterwards, copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>).</Step>
          <Step n={6}>Paste both the <code>xoxb-</code> bot token and the <code>xapp-</code> app token in the fields below.</Step>
          <div style={noteStyle}>
            💡 <span>You need to invite the bot to any channel where you want it active. In Slack, type <code>/invite @YourBotName</code> inside the channel.</span>
          </div>
        </div>
      );

    case 'Email':
      return (
        <div>
          <Step n={1}><strong>Gmail users:</strong> Go to myaccount.google.com → <strong>Security</strong>. You must have 2-Step Verification enabled. Then search for <strong>&quot;App Passwords&quot;</strong> in the search bar at the top.</Step>
          <Step n={2}>In App Passwords, select app type <strong>Mail</strong> and device <strong>Other (Custom name)</strong>. Name it &quot;Hermes&quot; and click <strong>Generate</strong>. Copy the 16-character password shown — you won&apos;t see it again.</Step>
          <Step n={3}><strong>IMAP settings for Gmail:</strong> Also confirm that IMAP is enabled in Gmail → Settings → See all settings → <strong>Forwarding and POP/IMAP</strong> → Enable IMAP.</Step>
          <Step n={4}>Enter your full email address (e.g. <code>myagent@gmail.com</code>), the 16-char App Password, and the standard Gmail servers: IMAP host <code>imap.gmail.com</code>, SMTP host <code>smtp.gmail.com</code>.</Step>
          <div style={noteStyle}>
            💡 <span><strong>Non-Gmail providers:</strong> Use your provider&apos;s IMAP/SMTP host. For Outlook: <code>imap-mail.outlook.com</code> / <code>smtp-mail.outlook.com</code>. You may need to enable &quot;Allow less secure apps&quot; or generate an app-specific password in your provider&apos;s account settings.</span>
          </div>
          <div style={warnStyle}>
            ⚠️ <span>It is strongly recommended to use a dedicated email account (not your personal one) for the agent — so it has a clean inbox only containing bot messages.</span>
          </div>
        </div>
      );

    case 'SMS (Twilio)':
      return (
        <div>
          <Step n={1}>Log in to <a href="https://console.twilio.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>console.twilio.com</a>. Your <strong>Account SID</strong> and <strong>Auth Token</strong> are shown directly on the Console home page.</Step>
          <Step n={2}><strong>Get a phone number:</strong> In the Console sidebar, go to <strong>Phone Numbers → Manage → Buy a number</strong>. Search for an SMS-capable number and purchase it. This is the number users will text.</Step>
          <Step n={3}><strong>Configure the webhook:</strong> Go to <strong>Phone Numbers → Manage → Active numbers</strong>, click your number. Under the <strong>Messaging</strong> section, set the webhook URL to your Hermes server&apos;s SMS endpoint (Hermes will provide this after you enter the credentials below). Set the method to <strong>HTTP POST</strong>.</Step>
          <Step n={4}>Copy your Account SID and Auth Token from step 1 and paste them below. Also enter the Twilio phone number you purchased (in E.164 format, e.g. <code>+15551234567</code>).</Step>
          <div style={noteStyle}>
            💡 <span>If you&apos;re on a Twilio trial, you can only send messages to verified numbers. Upgrade to a paid account for production use.</span>
          </div>
        </div>
      );

    case 'Signal':
      return (
        <div>
          <Step n={1}>Signal doesn&apos;t have an official bot API. Hermes uses the open-source <a href="https://github.com/bbernhard/signal-cli-rest-api" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>signal-cli-rest-api</a> project. You&apos;ll need to deploy it on a server first.</Step>
          <Step n={2}>Deploy the Signal CLI REST API using Docker: <br /><code style={{ fontSize: 11 }}>docker run -p 8080:8080 -v /home/user/.local/share/signal-cli:/home/user/.local/share/signal-cli bbernhard/signal-cli-rest-api</code></Step>
          <Step n={3}><strong>Register a phone number:</strong> Prepare a phone number that can receive SMS for verification. Call the REST API to register it: <code>POST /v1/register/+1234567890</code>. Then verify with the code you received via SMS: <code>POST /v1/register/+1234567890/verify/CODE</code>.</Step>
          <Step n={4}>Once registered, enter that phone number (in E.164 format) and the full URL to your signal-cli-rest-api instance (e.g. <code>http://your-server:8080</code>) below.</Step>
          <div style={warnStyle}>
            ⚠️ <span>Signal&apos;s Terms of Service prohibit automated bulk messaging. Use this integration for personal/private agent access only.</span>
          </div>
        </div>
      );

    case 'DingTalk':
      return (
        <div>
          <Step n={1}>Log in to the <a href="https://open-dev.dingtalk.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>DingTalk Open Platform</a> as an enterprise administrator.</Step>
          <Step n={2}>Go to <strong>Application Development → Enterprise Internal Development</strong> and click <strong>Create Application</strong>. Choose H5 Micro App or a robot-type app depending on your use case.</Step>
          <Step n={3}>After creating the app, go to <strong>Basic Information → Credentials &amp; Basic Information</strong>. Copy the <strong>AppKey</strong> (this is your Client ID) and <strong>AppSecret</strong> (Client Secret).</Step>
          <Step n={4}><strong>Grant permissions:</strong> Go to <strong>Permission Management</strong> and enable the APIs your agent needs (typically: <code>qyapi_robot_sendmsg</code> for sending messages, and contact/user reading APIs as needed).</Step>
          <Step n={5}><strong>Publish the app:</strong> Go to <strong>Version Management &amp; Release</strong> and publish a version — credentials won&apos;t become active until the app has a published version.</Step>
          <Step n={6}>Paste the AppKey and AppSecret below.</Step>
          <div style={noteStyle}>
            💡 <span>You can also use a Webhook-only bot for simpler notifications. In your DingTalk group → Group Settings → Group Assistant → Add Robot → Custom. This gives you a direct webhook URL without OAuth credentials.</span>
          </div>
        </div>
      );

    case 'WhatsApp':
      return (
        <div>
          <Step n={1}>WhatsApp doesn&apos;t require a token — Hermes connects via a QR code linking process (similar to WhatsApp Web).</Step>
          <Step n={2}>(Optional) Enter comma-separated phone numbers in international format that are <strong>allowed to message the bot</strong>. Leave blank to allow all contacts.</Step>
          <Step n={3}>Click <strong>Connect WhatsApp</strong> below. Hermes will prepare a session.</Step>
          <Step n={4}>Open your <strong>server terminal / console</strong> and run <code>/opt/hermes/.venv/bin/hermes whatsapp</code>. A QR code will appear.</Step>
          <Step n={5}>On your phone, open WhatsApp → three-dot menu → <strong>Linked Devices → Link a Device</strong>. Scan the QR code.</Step>
          <div style={warnStyle}>
            ⚠️ <span>This uses the Baileys library which connects as a standard WhatsApp client. Keep the server running continuously — if the session drops, you&apos;ll need to re-scan. WhatsApp may flag accounts with unusual automated activity.</span>
          </div>
        </div>
      );

    case 'Home Assistant':
      return (
        <div>
          <Step n={1}><strong>Best practice — create a dedicated user:</strong> In Home Assistant, go to <strong>Settings → People → Users tab</strong>, click <strong>Add User</strong>. Name it something like &quot;Hermes Bot&quot;. Do not make them an Admin unless needed.</Step>
          <Step n={2}>Log in to Home Assistant <em>as that new user</em> (open an incognito window or a different browser). Click the user avatar at the bottom-left to open the <strong>Profile</strong> page.</Step>
          <Step n={3}>Scroll to the bottom to find the <strong>Long-Lived Access Tokens</strong> section. Click <strong>Create Token</strong>, name it &quot;Hermes&quot;, and click OK.</Step>
          <Step n={4}><strong>Copy the token immediately</strong> — it will not be shown again. It looks like a long random string starting with <code>eyJ...</code>.</Step>
          <Step n={5}>Enter your Home Assistant URL (e.g. <code>http://homeassistant.local:8123</code> or your external HTTPS URL) and the token below.</Step>
          <div style={noteStyle}>
            💡 <span>If you&apos;re accessing HA remotely, make sure your URL is HTTPS with a valid certificate. <strong>Home Assistant Cloud (Nabu Casa)</strong> is the recommended way to expose HA safely to the internet.</span>
          </div>
        </div>
      );

    case 'GitHub':
      return (
        <div>
          <Step n={1}>Go to <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>github.com/settings/tokens</a> and click <strong>Generate new token (classic)</strong>.</Step>
          <Step n={2}>Give it a descriptive name (e.g. &quot;Hermes Agent&quot;), then set an expiry. Under <strong>Select scopes</strong>, check <strong>repo</strong>, <strong>read:org</strong>, and <strong>workflow</strong> for full Git and PR functionality.</Step>
          <Step n={3}>Scroll down and click <strong>Generate token</strong>. Copy the token shown — it starts with <code>ghp_</code> and will not be shown again.</Step>
          <Step n={4}>Paste the token below and click Connect. Hermes will configure <code>gh auth</code> and <code>git</code> to use it automatically.</Step>
          <div style={noteStyle}>
            💡 <span>For fine-grained tokens (GitHub&apos;s newer format), go to <strong>Fine-grained tokens</strong> instead. Grant <strong>Contents: read &amp; write</strong> and <strong>Pull requests: read &amp; write</strong> on the repos you want the agent to access.</span>
          </div>
        </div>
      );

    case 'Notion':
      return (
        <div>
          <Step n={1}>Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>notion.so/my-integrations</a> and click <strong>+ New integration</strong>.</Step>
          <Step n={2}>Name it (e.g. &quot;Hermes Agent&quot;), select your workspace, and click <strong>Submit</strong>. On the next screen, copy the <strong>Internal Integration Secret</strong> (starts with <code>secret_</code>).</Step>
          <Step n={3}><strong>Connect your pages:</strong> Open any Notion page you want the agent to access → click the <strong>⋯</strong> menu → <strong>Add connections</strong> → select your integration. Repeat for each page or database.</Step>
          <Step n={4}>Paste the integration secret below and click Connect.</Step>
          <div style={noteStyle}>
            💡 <span>The agent can only access pages and databases that you explicitly connect to it. If it can&apos;t find a page, add the connection from that page&apos;s menu.</span>
          </div>
        </div>
      );

    case 'Linear':
      return (
        <div>
          <Step n={1}>Open Linear and go to <strong>Settings → API</strong> (or visit <a href="https://linear.app/settings/api" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>linear.app/settings/api</a>).</Step>
          <Step n={2}>Under <strong>Personal API keys</strong>, click <strong>Create key</strong>. Give it a label like &quot;Hermes Agent&quot; and click <strong>Create</strong>.</Step>
          <Step n={3}>Copy the key shown — it starts with <code>lin_api_</code> and will not be displayed again.</Step>
          <Step n={4}>Paste it below and click Connect. Hermes will be able to create, update, and search your Linear issues.</Step>
          <div style={noteStyle}>
            💡 <span>Personal API keys have the same permissions as your Linear account. The agent will act on your behalf across all teams you are a member of.</span>
          </div>
        </div>
      );

    case 'X (Twitter)':
      return (
        <div>
          <Step n={1}>Go to the <a href="https://developer.twitter.com/en/portal/dashboard" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>X Developer Portal</a> and sign in. If you don&apos;t have a developer account, apply for one first (usually instant for Free tier).</Step>
          <Step n={2}>Create a new project and app. Under <strong>App Settings → User authentication settings</strong>, enable <strong>OAuth 1.0a</strong> with <strong>Read and Write</strong> permissions.</Step>
          <Step n={3}>Navigate to your app&apos;s <strong>Keys and Tokens</strong> tab. Copy your <strong>API Key</strong>, <strong>API Key Secret</strong>, <strong>Access Token</strong>, and <strong>Access Token Secret</strong>.</Step>
          <Step n={4}>Paste all four values in the fields below and click Connect. Hermes will be able to post, read, search, and manage your X account.</Step>
          <div style={warnStyle}>
            ⚠️ <span>The Free tier has rate limits (e.g. 1,500 tweets/month). Posting frequently may exhaust your quota. Monitor usage at <strong>developer.twitter.com/en/portal/products</strong>.</span>
          </div>
        </div>
      );

    case 'Google Workspace':
      return (
        <div>
          <div style={noteStyle}>
            💡 <span>You are creating personal API credentials for your Agent. These credentials never touch our servers—they remain securely inside your isolated Agent container.</span>
          </div>
          <Step n={1}>Log into <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>Google Cloud Console</a>. Click the project dropdown at the top left and select <strong>New Project</strong>. Name it &quot;Hermes Agent Workspace&quot; and create it.</Step>
          <Step n={2}>Once created, ensure the project is selected. In the sidebar, go to <strong>APIs &amp; Services → Library</strong>.</Step>
          <Step n={3}>Search for and <strong>Enable</strong> all three of these APIs: <br/>• <strong>Gmail API</strong><br/>• <strong>Google Drive API</strong><br/>• <strong>Google Calendar API</strong></Step>
          <Step n={4}>Go to <strong>APIs &amp; Services → OAuth consent screen</strong>. Choose <strong>External</strong> and click Create. Fill in the required <em>App name</em> and <em>User support email</em> fields, then Save and Continue.</Step>
          <Step n={5}>Skip the Scopes page (Save and Continue). On the <strong>Test users</strong> page, click <strong>+ Add Users</strong> and enter your own Google account email address. Save and Continue.</Step>
          <Step n={6}>Finally, go to <strong>Credentials</strong> on the left sidebar. Click <strong>+ Create Credentials → OAuth client ID</strong>. Select <strong>Desktop app</strong> as the application type and click Create.</Step>
          <Step n={7}>A dialog will appear with your Client ID and Client Secret. Click <strong>Download JSON</strong>. Paste the complete contents of that downloaded file right here into the input box below.</Step>
          <div style={warnStyle}>
            ⚠️ <span>Make sure you select &quot;Desktop app&quot; on step 6! If you select Web application, the authentication flow will fail.</span>
          </div>
        </div>
      );

    case 'BlueBubbles':
      return (
        <div>
          <Step n={1}>Set up <a href="https://bluebubbles.app/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>BlueBubbles</a> on a Mac device to act as your iMessage server.</Step>
          <Step n={2}>Once your BlueBubbles server is running, locate your <strong>Server URL</strong> (typically a ngrok/cloudflare URL) and your <strong>Server Password</strong> in the BlueBubbles server dashboard.</Step>
          <Step n={3}>Paste both the URL and Password below. Hermes will connect to the server and be able to send/receive messages via Apple Messages.</Step>
          <div style={warnStyle}>
            ⚠️ <span>You must have the BlueBubbles server running continuously on a macOS machine (or VM) for this integration to work.</span>
          </div>
        </div>
      );

    case 'Matrix':
      return (
        <div>
          <Step n={1}>Create a new user account for your bot on your preferred Matrix homeserver (e.g. <code>matrix.org</code> or your self-hosted server).</Step>
          <Step n={2}>Log in to the Matrix account using Element or a similar client, go to Settings → Help &amp; About, and find your <strong>Access Token</strong> (under Advanced).</Step>
          <Step n={3}>Alternatively, if your server supports password login, Hermes can authenticate using the bot&apos;s password.</Step>
          <Step n={4}>Paste the <strong>Homeserver URL</strong> (e.g. <code>https://matrix.org</code>), <strong>User ID</strong> (e.g. <code>@hermes_bot:matrix.org</code>), and the <strong>Access Token</strong> below.</Step>
          <div style={noteStyle}>
            💡 <span>If you want the bot to participate in end-to-end encrypted rooms, ensure you have enabled pantomime/encryption in the agent&apos;s advanced local config.</span>
          </div>
        </div>
      );

    case 'Mattermost':
      return (
        <div>
          <Step n={1}>Log in to Mattermost with administrative privileges, or ask an administrator to enable Bot Accounts.</Step>
          <Step n={2}>Go to <strong>Main Menu → Integrations → Bot Accounts</strong> and click <strong>Add Bot Account</strong>.</Step>
          <Step n={3}>Set the Username and Display Name for the agent. Assign the appropriate roles (e.g. Member) and click Create.</Step>
          <Step n={4}>Copy the <strong>Access Token</strong> provided. This is only shown once!</Step>
          <Step n={5}>Paste your <strong>Mattermost URL</strong> and the <strong>Access Token</strong> below.</Step>
          <div style={noteStyle}>
            💡 <span>You will need to manually invite the bot account to any private channels where you want it to participate.</span>
          </div>
        </div>
      );

    case 'WeCom':
      return (
        <div>
          <Step n={1}>Log in to the WeCom (WeChat Work) Admin Console and navigate to <strong>App Management</strong>.</Step>
          <Step n={2}>Click <strong>Create an App</strong> and fill out the bot&apos;s details.</Step>
          <Step n={3}>Once created, copy the <strong>AgentId</strong> (Bot ID) and <strong>Secret</strong>.</Step>
          <Step n={4}>Paste the <strong>Bot ID</strong> and <strong>Secret</strong> down below.</Step>
          <div style={warnStyle}>
            ⚠️ <span>Make sure you configure the required IP allowlist in the WeCom console so that Hermes can connect to their API.</span>
          </div>
        </div>
      );

    case 'WeChat':
      return (
        <div>
          <Step n={1}>Log in to the WeChat Official Accounts Platform.</Step>
          <Step n={2}>Navigate to <strong>Settings → Basic Details</strong> to find your <strong>Original ID</strong> (Account ID).</Step>
          <Step n={3}>Navigate to <strong>Developer Tools</strong> and get your <strong>Developer Password (AppSecret)</strong>, which acts as your Token for Hermes.</Step>
          <Step n={4}>Paste the <strong>Account ID</strong> and <strong>Token</strong> below to connect.</Step>
          <div style={noteStyle}>
            💡 <span>WeChat&apos;s API has strict requirements for response times and message formatting. Make sure your agent is configured to reply quickly or use delayed chunking.</span>
          </div>
        </div>
      );

    case 'Feishu':
      return (
        <div>
          <Step n={1}>Log in to the <a href="https://open.feishu.cn/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink-black)', fontWeight: 600 }}>Feishu Developer Platform</a> and click <strong>Create Custom App</strong>.</Step>
          <Step n={2}>Under <strong>Credentials &amp; Basic Info</strong>, copy the <strong>App ID</strong> and <strong>App Secret</strong>.</Step>
          <Step n={3}>Under <strong>Permissions</strong>, request the necessary scope for sending and receiving messages.</Step>
          <Step n={4}>Under <strong>Event Subscriptions</strong>, configure your Webhook URL or enable WebSocket mode, then generate a version and publish the app.</Step>
          <Step n={5}>Paste the <strong>App ID</strong> and <strong>App Secret</strong> below.</Step>
        </div>
      );

    default:
      return null;
  }
};
