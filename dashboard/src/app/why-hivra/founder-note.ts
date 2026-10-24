// The founder's note on /why-hivra, written out in full. Source: the owner's
// 2026-10 website copy (batch 01, page 3). The wording below is the owner's;
// change it only on the owner's say-so.
//
// The page used to read the staged copy of THOUGHTS.md at render time. It now
// owns its text: THOUGHTS.md stays what the litepaper links to ("my full
// thoughts"), and the two are deliberately separate.
//
// A paragraph is a list of spans: plain strings, and links to the sources the
// note cites. The four source links sit on phrases already in the sentence, so
// no wording changes. The OpenAI "Astra" report is not linked (owner decision).
//
// 2026-10-21: the capability sentence says only what the linked sources support,
// "discovering vulnerabilities". The owner's "producing exploit chains and
// performing sophisticated security tasks" and "research from frontier labs ...
// under controlled testing" are out: neither the Big Sleep nor the XBOW post
// describes exploit chains, and the Anthropic page is about deceptive models
// that survive safety training, not about finding vulnerabilities. The next
// paragraph says "those things" (not "all of those things") because the list
// it points back to is now two results, not three capabilities.

export interface NoteLink {
  text: string;
  href: string;
}

export type NoteSpan = string | NoteLink;

/** "pull" is a line set apart in larger type; "signoff" is the last line of the note. */
export type NoteParagraphRole = "pull" | "signoff";

export interface NoteParagraph {
  spans: readonly NoteSpan[];
  role?: NoteParagraphRole;
}

export interface NoteSection {
  id: string;
  heading: string;
  paragraphs: readonly NoteParagraph[];
}

export interface FounderNote {
  heading: string;
  /** The paragraphs under the title, before the first heading. */
  opening: readonly NoteParagraph[];
  sections: readonly NoteSection[];
}

/** The four sources the note cites, each checked on 2026-10-20 (the OpenAI page refuses scripted fetches but loads in a browser). */
export const NOTE_SOURCES = {
  bigSleep: "https://projectzero.google/2024/10/from-naptime-to-big-sleep.html",
  xbow: "https://xbow.com/blog/top-1-how-xbow-did-it",
  sleeperAgents:
    "https://www.anthropic.com/research/sleeper-agents-training-deceptive-llms-that-persist-through-safety-training",
  promptInjection: "https://openai.com/index/prompt-injections/",
} as const;

function link(text: string, href: string): NoteLink {
  return { text, href };
}

function para(...spans: NoteSpan[]): NoteParagraph {
  return { spans };
}

function pull(...spans: NoteSpan[]): NoteParagraph {
  return { spans, role: "pull" };
}

function signoff(...spans: NoteSpan[]): NoteParagraph {
  return { spans, role: "signoff" };
}

export const FOUNDER_NOTE: FounderNote = {
  heading: "Why I'm building Hivra",
  opening: [
    para(
      "I use AI agents almost every day. I build software with them, get them to investigate things I don't have time to investigate myself, and hand them work that used to take me days.",
    ),
    para(
      "I don't want to go back to doing all of that by hand. I want agents to become more capable, not less.",
    ),
    para("I just don't want to give them my entire computer to make it happen."),
    para(
      "That's the problem Hivra started with. Not how to create another chatbot, or another model, or even another agent. How do you give the agents people already use somewhere sensible to work?",
    ),
  ],
  sections: [
    {
      id: "a-computer-full-of-things",
      heading: "A computer full of things an agent doesn't need",
      paragraphs: [
        para(
          "Think about what sits on an ordinary laptop. Family photos. Saved logins. Work documents. API keys. Messages. Maybe a wallet, financial records or access to a production server.",
        ),
        para(
          "Then think about what a coding or research agent is supposed to do: read and change files, execute commands, install software, browse pages and work through problems on its own.",
        ),
        para(
          "Those abilities are the point. But when the agent runs where everything else lives, every extra bit of access matters.",
        ),
        para(
          "You can tell it to stay in a particular folder. You can ask it to confirm before running a dangerous command. Those are worthwhile precautions. They aren't the same as keeping an unrelated file or credential outside the environment altogether.",
        ),
        para(
          "And, if I'm being practical, not everyone wants to spend their weekend setting up virtual machines, SSH access, desktops and persistent sessions just to work with an agent safely.",
        ),
        para("I wanted that part to be simple."),
      ],
    },
    {
      id: "better-agents-need-boundaries",
      heading: "Better agents make boundaries more important",
      paragraphs: [
        para(
          "This isn't an argument that today's models are secretly conscious or malicious. It's an argument about capability and access.",
        ),
        para(
          "Researchers and security teams have shown AI systems discovering vulnerabilities. Google's ",
          link("Big Sleep", NOTE_SOURCES.bigSleep),
          " uncovered a security issue in SQLite that existing automated testing had missed. ",
          link("XBOW", NOTE_SOURCES.xbow),
          " reported topping HackerOne's US leaderboard in 2025.",
        ),
        para(
          "The point isn't that every model can do those things in normal use. It can't. The point is that the abilities are improving, and we're increasingly giving agents the tools, accounts and time to act.",
        ),
        para(
          "Even without an attacker, agents make mistakes. They can misread instructions, change the wrong files or take a cleanup task further than anyone intended. A webpage or document can also contain malicious instructions directed at the model rather than the person who opened it. That's ",
          link("prompt injection", NOTE_SOURCES.promptInjection),
          ", and it becomes much more consequential when the model can act on accounts and files.",
        ),
        para("That is why I don't think we should rely solely on asking the model to behave."),
      ],
    },
    {
      id: "a-passed-test-is-not-a-guarantee",
      heading: "A model passing a test is not a guarantee",
      paragraphs: [
        para(
          "One piece of research that stuck with me came from ",
          link("Anthropic", NOTE_SOURCES.sleeperAgents),
          ". Researchers deliberately trained models with hidden trigger behaviours and then tried to remove those behaviours using common safety-training techniques. The behaviours sometimes survived. In some cases, adversarial training appeared to make them harder to detect.",
        ),
        para(
          "That's research under constructed conditions, not proof that a particular product is deceiving its users. But it challenges an assumption I think is too easy to make: that because a system sounds responsible, or passes a set of tests, it can be trusted with any access we give it.",
        ),
        para("I don't think that follows."),
        para(
          "The safer starting point is to limit what it can reach in the first place. Keep important accounts behind explicit permission boundaries. Let someone inspect what happened. Make it possible to revoke access and shut things down.",
        ),
        pull("The agent shouldn't be the only thing responsible for policing the agent."),
      ],
    },
    {
      id: "a-personal-reason",
      heading: "There's also a personal reason",
      paragraphs: [
        para(
          "I'm a Christian, and my faith shapes how I think about power, responsibility and the future we're building.",
        ),
        para(
          "I believe there's a genuine danger in a world where access to money, work and everyday services becomes concentrated in systems that can decide who is allowed to take part. Scripture's warnings about control over buying and selling are part of how I think about that future. I can see AI making such control far easier to administer at scale.",
        ),
        para(
          "That's my interpretation and my concern. I'm not claiming that every AI system is part of a biblical prophecy, or asking people to share my beliefs to use Hivra.",
        ),
        para("You don't have to agree with me at all."),
        para(
          "But it helps explain why I care so much about accountability, user control and infrastructure people can operate for themselves. I don't want every meaningful decision about access to live inside a system no one can inspect or question.",
        ),
      ],
    },
    {
      id: "the-practical-answer",
      heading: "The practical answer I'm trying to build",
      paragraphs: [
        para(
          "Hivra starts simply: give the agent a computer of its own. Let someone launch it without turning into a systems administrator. Let them check what it's doing, reach it from another device and connect only the things the work requires.",
        ),
        para(
          "Make the software open source. Let people run it on their own infrastructure. Don't make a token a condition of using it. Don't ask anyone to trust us merely because we say the system is secure.",
        ),
        para(
          "That doesn't solve every problem. A badly configured computer can still expose something it shouldn't. A trusted account can still be misused. And the larger questions about agent autonomy, security and concentration of power will take more than one company to answer.",
        ),
        para("But it's a useful place to begin, and it works with the agents we have today."),
        para(
          "I want AI to be powerful enough to do real work, with boundaries that remain meaningful when it gets more powerful.",
        ),
        signoff("That's why I'm building Hivra."),
      ],
    },
  ],
};

/** Plain text of one paragraph (links read as their text). */
export function paragraphText(paragraph: NoteParagraph): string {
  return paragraph.spans.map((span) => (typeof span === "string" ? span : span.text)).join("");
}

/** Every paragraph of the note in reading order. */
export function allParagraphs(note: FounderNote = FOUNDER_NOTE): NoteParagraph[] {
  return [...note.opening, ...note.sections.flatMap((section) => section.paragraphs)];
}
