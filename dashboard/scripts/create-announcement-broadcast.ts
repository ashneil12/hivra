import { Resend, type CreateBroadcastOptions } from "resend";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const DEFAULT_SEGMENT_NAME = "Hermes OS customers";
const DEFAULT_TOPIC_NAME = "Product updates";

type Options = {
  apply: boolean;
  send: boolean;
  subject: string;
  name: string;
  bodyFile: string;
  previewText: string | null;
  segmentName: string;
  topicName: string;
};

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const subjectArg = args.find((arg) => arg.startsWith("--subject="));
  const nameArg = args.find((arg) => arg.startsWith("--name="));
  const bodyArg = args.find((arg) => arg.startsWith("--body="));
  const previewArg = args.find((arg) => arg.startsWith("--preview="));
  const segmentArg = args.find((arg) => arg.startsWith("--segment="));
  const topicArg = args.find((arg) => arg.startsWith("--topic="));

  return {
    apply: args.includes("--apply"),
    send: args.includes("--send"),
    subject: subjectArg?.slice("--subject=".length).trim() || "",
    name: nameArg?.slice("--name=".length).trim() || "",
    bodyFile: bodyArg?.slice("--body=".length).trim() || "",
    previewText: previewArg?.slice("--preview=".length).trim() || null,
    segmentName:
      segmentArg?.slice("--segment=".length).trim() ||
      process.env.RESEND_ANNOUNCEMENT_SEGMENT?.trim() ||
      DEFAULT_SEGMENT_NAME,
    topicName:
      topicArg?.slice("--topic=".length).trim() ||
      process.env.RESEND_ANNOUNCEMENT_TOPIC?.trim() ||
      DEFAULT_TOPIC_NAME,
  };
}

function assertValidOptions(options: Options) {
  if (!options.subject) throw new Error("Missing --subject");
  if (!options.bodyFile) throw new Error("Missing --body");
  if (!options.segmentName) throw new Error("--segment must not be empty");
  if (!options.topicName) throw new Error("--topic must not be empty");
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHtml(body: string) {
  const paragraphs = body
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      ${paragraphs}
      <p style="margin-top:32px;color:#666666;font-size:13px;line-height:1.5;">
        You are receiving this because you signed up for Hermes OS.
        <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#111111;text-decoration:underline;">Unsubscribe from product updates</a>.
      </p>
    </div>
  </body>
</html>`;
}

function renderText(body: string) {
  return `${body.trim()}

--
You are receiving this because you signed up for Hermes OS.
Unsubscribe from product updates: {{{RESEND_UNSUBSCRIBE_URL}}}`;
}

async function findSegmentId(resend: Resend, name: string) {
  const response = await resend.segments.list({ limit: 100 });
  if (response.error) throw new Error(`Failed to list Resend segments: ${response.error.message}`);
  const segment = response.data.data.find((item) => item.name === name);
  if (!segment) throw new Error(`Resend segment "${name}" does not exist. Run email:audience:setup first.`);
  return segment.id;
}

async function findTopicId(resend: Resend, name: string) {
  const response = await resend.topics.list();
  if (response.error) throw new Error(`Failed to list Resend topics: ${response.error.message}`);
  const topic = response.data.data.find((item) => item.name === name);
  if (!topic) throw new Error(`Resend topic "${name}" does not exist. Run email:audience:setup first.`);
  return topic.id;
}

async function main() {
  const options = parseOptions();
  assertValidOptions(options);

  const resendApiKey = requireEnv("RESEND_API_KEY");
  const from = requireEnv("RESEND_FROM_EMAIL");
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL?.trim() || "info@hermesos.cloud";
  const bodyPath = path.resolve(process.cwd(), options.bodyFile);
  const body = fs.readFileSync(bodyPath, "utf8").trim();
  if (!body) throw new Error(`Body file is empty: ${bodyPath}`);
  const text = renderText(body);

  const resend = new Resend(resendApiKey);
  const segmentId = await findSegmentId(resend, options.segmentName);
  const topicId = await findTopicId(resend, options.topicName);
  const broadcastName =
    options.name || `${options.topicName} - ${new Date().toISOString().slice(0, 10)}`;

  console.log(`${options.apply ? "Creating" : "Dry run for"} Resend Broadcast.`);
  console.log(`Name: ${broadcastName}`);
  console.log(`Subject: ${options.subject}`);
  console.log(`Segment: ${options.segmentName} (${segmentId})`);
  console.log(`Topic: ${options.topicName} (${topicId})`);
  console.log(`Mode: ${options.send ? "send now" : "draft"}`);

  if (!options.apply) {
    console.log("No Broadcast was created. Re-run with --apply to create a draft.");
    return;
  }

  const broadcastOptions: CreateBroadcastOptions = options.send
    ? {
        name: broadcastName,
        from,
        replyTo,
        subject: options.subject,
        previewText: options.previewText || undefined,
        html: renderHtml(body),
        text,
        segmentId,
        topicId,
        send: true,
      }
    : {
        name: broadcastName,
        from,
        replyTo,
        subject: options.subject,
        previewText: options.previewText || undefined,
        html: renderHtml(body),
        text,
        segmentId,
        topicId,
        send: false,
      };

  const response = await resend.broadcasts.create(broadcastOptions);

  if (response.error) {
    throw new Error(`Failed to create Resend Broadcast: ${response.error.message}`);
  }

  console.log(`Broadcast ${options.send ? "sent" : "created as draft"}: ${response.data.id}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
