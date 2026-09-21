/**
 * Embedded list of well-known disposable / throwaway email domains.
 *
 * This catches the high-volume offenders (mailinator, guerrillamail, 10minutemail,
 * tempmail variants, etc.) without adding a runtime dependency. The full
 * community list at https://github.com/disposable-email-domains/disposable-email-domains
 * has ~6k entries and is updated weekly; for free-tier abuse prevention the
 * top ~150 below cover the vast majority of throwaway signups.
 *
 * To upgrade later: `npm i disposable-email-domains` and replace DISPOSABLE_DOMAINS
 * with `import disposableDomains from 'disposable-email-domains'` then convert
 * to a Set on module load.
 */

const DISPOSABLE_DOMAINS = new Set<string>([
  // Mailinator family
  "mailinator.com",
  "mailinator.net",
  "mailinator.org",
  "mailinator2.com",
  "binkmail.com",
  "bobmail.info",
  "chammy.info",
  "devnullmail.com",
  "letthemeatspam.com",
  "mailimate.com",
  "mailin8r.com",
  "mailinator.gq",
  "mailinator.ml",
  "mailinator.tk",
  "notmailinator.com",
  "reallymymail.com",
  "reconmail.com",
  "safetymail.info",
  "sendspamhere.com",
  "sogetthis.com",
  "spam4.me",
  "streetwisemail.com",
  "suremail.info",
  "thisisnotmyrealemail.com",
  "tradermail.info",
  "veryrealemail.com",
  "zippymail.info",

  // Guerrilla Mail family
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamailblock.com",
  "grr.la",
  "sharklasers.com",
  "spam4.me",
  "pokemail.net",

  // 10MinuteMail family
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.org",
  "10minutemail.us",
  "10minutemail.de",
  "10minutemail.co.uk",
  "20minutemail.com",
  "30minutemail.com",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",

  // TempMail family
  "tempmail.com",
  "tempmail.net",
  "tempmail.org",
  "tempmail.de",
  "tempmail.us",
  "temp-mail.org",
  "temp-mail.io",
  "temp-mail.ru",
  "tempmailaddress.com",
  "tempmaila.com",
  "tempmailo.com",
  "tempr.email",

  // Yopmail family
  "yopmail.com",
  "yopmail.net",
  "yopmail.fr",
  "cool.fr.nf",
  "courriel.fr.nf",
  "jetable.fr.nf",
  "moncourrier.fr.nf",
  "monemail.fr.nf",
  "monmail.fr.nf",

  // Throwaway services
  "throwawaymail.com",
  "throwawayemailaddresses.com",
  "throwam.com",
  "trashmail.com",
  "trashmail.net",
  "trashmail.io",
  "trashmail.de",
  "trashmail.me",
  "trashmail.ws",
  "trash-mail.com",
  "trash-mail.de",
  "dispostable.com",
  "discard.email",
  "discardmail.com",
  "discardmail.de",

  // Maildrop family
  "maildrop.cc",
  "maildrop.cf",
  "maildrop.gq",
  "maildrop.ga",
  "maildrop.ml",
  "maildrop.tk",

  // GetNada
  "getnada.com",
  "getairmail.com",

  // Other common throwaways
  "fakeinbox.com",
  "fakemail.net",
  "spambox.us",
  "spambog.com",
  "spambog.de",
  "spambog.ru",
  "deadaddress.com",
  "incognitomail.com",
  "incognitomail.net",
  "incognitomail.org",
  "mintemail.com",
  "mt2014.com",
  "mt2015.com",
  "mytrashmail.com",
  "no-spam.ws",
  "nobulk.com",
  "noclickemail.com",
  "nogmailspam.info",
  "nomail.xl.cx",
  "nospam.ze.tc",
  "objectmail.com",
  "obobbo.com",
  "owlpic.com",
  "pjjkp.com",
  "plexolan.de",
  "poofy.org",
  "pookmail.com",
  "privacy.net",
  "punkass.com",
  "qq.com.de",
  "quickinbox.com",
  "rcpt.at",
  "recode.me",
  "regbypass.com",
  "rmqkr.net",
  "rppkn.com",
  "rtrtr.com",
  "sandelf.de",
  "saynotospams.com",
  "sayy.tk",
  "selfdestructingmail.com",
  "sendfree.org",
  "sharedmailbox.org",
  "shieldedmail.com",
  "shitmail.me",
  "shitware.nl",
  "skeefmail.com",
  "smaakt.naar.gravel.com",
  "smashmail.de",
  "smellfear.com",
  "snakemail.com",
  "sneakemail.com",
  "snkmail.com",
  "sofimail.com",
  "sofort-mail.de",
  "spam.la",
  "spam.su",
  "spamavert.com",
  "spambob.com",
  "spambob.net",
  "spambob.org",
  "spamcero.com",
  "spamcon.org",
  "spamcorptastic.com",
  "spamcowboy.com",
  "spamcowboy.net",
  "spamcowboy.org",
  "spamday.com",
  "spamex.com",
  "spamfree.eu",
  "spamfree24.com",
  "spamfree24.de",
  "spamfree24.eu",
  "spamfree24.info",
  "spamfree24.net",
  "spamfree24.org",
  "spamgoes.in",
  "spamhereplease.com",
  "spamherelots.com",
  "spamhole.com",
  "spamify.com",
  "spaminator.de",
  "spamkill.info",
  "spamoff.de",
  "spamslicer.com",
  "spamspot.com",
  "spamthis.co.uk",
  "spamthisplease.com",
  "spamtrail.com",
  "spamtroll.net",
  "speed.1s.fr",
  "supergreatmail.com",
  "superrito.com",
  "tagyourself.com",
  "talkinator.com",
  "teewars.org",
  "teleworm.com",
  "teleworm.us",
  "thanksnospam.info",
  "thankyou2010.com",
  "thecloudindex.com",
  "tilien.com",
  "tmail.ws",
  "tmailinator.com",
  "tradermail.info",
  "twinmail.de",
  "twoweirdtricks.com",
  "umail.net",
  "uggsrock.com",
  "venompen.com",
  "veryrealemail.com",
  "vidchart.com",
  "vomoto.com",
  "vpn.st",
  "vsimcard.com",
  "vubby.com",
  "wasteland.rfc822.org",
  "webemail.me",
  "webm4il.info",
  "wegwerfadresse.de",
  "wegwerfemail.com",
  "wegwerfemail.de",
  "wegwerfmail.de",
  "wegwerfmail.info",
  "wegwerfmail.net",
  "wegwerfmail.org",
  "wh4f.org",
  "whatpaas.com",
  "whyspam.me",
  "willhackforfood.biz",
  "willselfdestruct.com",
  "winemaven.info",
  "wronghead.com",
  "wuzup.net",
  "wuzupmail.net",
  "www.e4ward.com",
  "yapped.net",
  "yeah.net",
  "yep.it",
  "yogamaven.com",
  "yuurok.com",
  "zoaxe.com",
  "zoemail.org",
  "zomg.info",
]);

export interface EmailSignals {
  domain: string;
  isDisposable: boolean;
}

/**
 * Check whether an email address is from a known disposable / throwaway domain.
 *
 * Returns null for empty / unparseable input so the risk scorer can treat
 * "no email signal" as neutral. Treats unknown-but-suspicious domains as
 * non-disposable (false negatives are acceptable; false positives would
 * block legit users on uncommon domains).
 */
export function checkEmail(email: string | null | undefined): EmailSignals | null {
  if (!email || typeof email !== "string") return null;

  const trimmed = email.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;

  const domain = trimmed.slice(atIdx + 1);
  if (!domain || !domain.includes(".")) return null;

  return {
    domain,
    isDisposable: DISPOSABLE_DOMAINS.has(domain),
  };
}

/** Exposed for tests — read-only snapshot of the disposable domain set. */
export function _getDisposableDomainsSnapshot(): ReadonlySet<string> {
  return DISPOSABLE_DOMAINS;
}
