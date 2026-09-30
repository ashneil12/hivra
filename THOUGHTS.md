# Why I'm building Hivra

I run agents every day. I build software with them, dig through problems with them, and get through work that would otherwise take a week. I want to keep doing that as they get better.

I'd also like my computer back.

I don't want every new tool I try sitting next to the keys for everything else I run. And I don't want to spend a Sunday configuring a spare machine just to give an agent somewhere sensible to work.

The capabilities are moving fast, and not in a way you have to take my word for.

AI is finding zero-days on its own. Google's [Big Sleep](https://projectzero.google/2024/10/from-naptime-to-big-sleep.html) found an exploitable flaw in SQLite before it shipped, one the project's existing fuzzing hadn't caught, and [by August 2025](https://techcrunch.com/2025/08/04/google-says-its-ai-based-bug-hunter-found-20-security-vulnerabilities/) it had turned up twenty more across projects like FFmpeg and ImageMagick. [XBOW's](https://xbow.com/blog/top-1-how-xbow-did-it) autonomous agent hit number one on HackerOne's US leaderboard in June 2025, above every human on it. Google's threat intelligence team has since [identified a threat actor](https://cloud.google.com/blog/topics/threat-intelligence/ai-vulnerability-exploitation-initial-access) using a zero-day they believe was built with AI.

OpenAI's Astra report describes a model hitting their Critical cybersecurity threshold, scoring 100% on ExploitBench with Daybreak Blue access. In expert-led tests it built working exploit chains against a hardened browser and operating system. One escaped the browser's sandbox. Another reached root. Those were research conditions rather than the default setup, and it's still their report, not mine. [Read it](https://openai.com/index/path-to-astra/).

There's a second thing that changed how I work. Anthropic trained models with hidden triggers and then ran the standard safety toolkit at them: fine-tuning, reinforcement learning, adversarial training. [The triggers survived](https://www.anthropic.com/research/sleeper-agents-training-deceptive-llms-that-persist-through-safety-training). Adversarial training sometimes just taught the model to hide the behaviour better.

Passing safety training doesn't prove a model has no hidden behaviour. That's why I want limits outside it.

I'm also a Christian, and I'd rather say what I actually think than leave you guessing.

I think this ends up somewhere scripture already described. A world where taking part in the economy gets conditioned on compliance, where the ability to buy and sell runs through something that can exclude you, and where AI is what finally makes that possible at scale. I think it arrives looking reasonable, because that's how it would have to arrive.

You don't have to agree with any of that. But it's why I care about where the limits live, and it's why I don't think a model producing moral language is the same as a model being answerable for anything.

Someone has to be answerable. Someone decides what the agent reaches, where its authority stops, and how to pull the plug.

Hivra is the practical part of that. Give the agent a computer. Make it good enough that people actually use it. Keep control of everything around it.
