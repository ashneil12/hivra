//! Signing in through the person's own browser.
//!
//! The same hand-off as the Mac app (apps/macos/HivraMac, `HivraBrowserSignIn`)
//! and the website (dashboard/src/lib/desktop/browser-sign-in.ts): open
//! `/desktop/sign-in` with the SHA-256 of a random verifier, receive
//! `hivra://auth/callback?code=…&state=…`, trade code + verifier for a
//! one-time ticket at `/api/desktop/session`, then open `/desktop/finish`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    SignIn,
    SignUp,
}

impl Intent {
    pub fn parse(value: &str) -> Intent {
        if value == "sign-up" {
            Intent::SignUp
        } else {
            Intent::SignIn
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Intent::SignIn => "sign-in",
            Intent::SignUp => "sign-up",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub verifier: String,
    pub state: String,
}

impl Request {
    pub fn new() -> Request {
        Request { verifier: random_base64url(32), state: random_base64url(24) }
    }

    pub fn challenge(&self) -> String {
        challenge_for(&self.verifier)
    }

    pub fn browser_url(&self, connection: &Url, intent: Intent) -> Option<Url> {
        let mut url = origin(connection)?;
        url.set_path("/desktop/sign-in");
        url.query_pairs_mut()
            .append_pair("challenge", &self.challenge())
            .append_pair("state", &self.state)
            .append_pair("intent", intent.as_str());
        Some(url)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Callback {
    pub code: String,
    pub state: String,
}

/// `hivra://auth/callback?code=…&state=…`, or None for any other address.
pub fn callback(url: &Url) -> Option<Callback> {
    if url.scheme() != "hivra" || url.host_str() != Some("auth") || url.path() != "/callback" {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if !value.is_empty() => code = Some(value.into_owned()),
            "state" if !value.is_empty() => state = Some(value.into_owned()),
            _ => {}
        }
    }
    Some(Callback { code: code?, state: state? })
}

pub fn exchange_url(connection: &Url) -> Option<Url> {
    let mut url = origin(connection)?;
    url.set_path("/api/desktop/session");
    Some(url)
}

pub fn finish_url(connection: &Url, ticket: &str) -> Option<Url> {
    let mut url = origin(connection)?;
    url.set_path("/desktop/finish");
    url.query_pairs_mut().append_pair("ticket", ticket);
    Some(url)
}

/// `{"success":true,"data":{"ticket":"…"}}` → the ticket.
pub fn ticket_from_response(body: &serde_json::Value) -> Option<String> {
    let ticket = body.get("data")?.get("ticket")?.as_str()?;
    (!ticket.is_empty()).then(|| ticket.to_string())
}

/// The website's own sign-in or sign-up page on this connection.
pub fn is_sign_in_page(url: &Url, connection: &Url) -> bool {
    if url.scheme() != connection.scheme()
        || url.host_str() != connection.host_str()
        || url.port_or_known_default() != connection.port_or_known_default()
    {
        return false;
    }
    let path = url.path().to_ascii_lowercase();
    ["/sign-in", "/sign-up"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn origin(url: &Url) -> Option<Url> {
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    let mut origin = url.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    origin.set_username("").ok()?;
    origin.set_password(None).ok()?;
    Some(origin)
}

fn random_base64url(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Url {
        Url::parse("https://hivra.cloud/dashboard").unwrap()
    }

    #[test]
    fn challenge_matches_rfc_7636() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn fresh_requests_are_long_and_unique() {
        let request = Request::new();
        assert_eq!(request.verifier.len(), 43);
        assert_eq!(request.state.len(), 32);
        assert_ne!(Request::new(), request);
    }

    #[test]
    fn browser_url_is_on_the_connection_origin() {
        let request = Request {
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
            state: "state_value_123456".into(),
        };
        assert_eq!(
            request.browser_url(&connection(), Intent::SignUp).unwrap().as_str(),
            "https://hivra.cloud/desktop/sign-in?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=state_value_123456&intent=sign-up"
        );
    }

    #[test]
    fn reads_only_the_auth_callback() {
        let ok = callback(&Url::parse("hivra://auth/callback?code=abc&state=xyz").unwrap());
        assert_eq!(ok, Some(Callback { code: "abc".into(), state: "xyz".into() }));
        assert_eq!(callback(&Url::parse("hivra://auth/callback?code=abc").unwrap()), None);
        assert_eq!(callback(&Url::parse("hivra://other/callback?code=a&state=b").unwrap()), None);
        assert_eq!(callback(&Url::parse("https://auth/callback?code=a&state=b").unwrap()), None);
    }

    #[test]
    fn builds_exchange_and_finish_addresses() {
        assert_eq!(exchange_url(&connection()).unwrap().as_str(), "https://hivra.cloud/api/desktop/session");
        assert_eq!(finish_url(&connection(), "t+1").unwrap().as_str(), "https://hivra.cloud/desktop/finish?ticket=t%2B1");
    }

    #[test]
    fn reads_the_ticket() {
        let ok = serde_json::json!({"success": true, "data": {"ticket": "abc"}});
        assert_eq!(ticket_from_response(&ok), Some("abc".into()));
        assert_eq!(ticket_from_response(&serde_json::json!({"success": false})), None);
    }

    #[test]
    fn spots_sign_in_pages_on_the_same_origin_only() {
        let c = connection();
        assert!(is_sign_in_page(&Url::parse("https://hivra.cloud/sign-in?redirect_url=%2Fdashboard").unwrap(), &c));
        assert!(is_sign_in_page(&Url::parse("https://hivra.cloud/sign-up/verify").unwrap(), &c));
        assert!(!is_sign_in_page(&Url::parse("https://hivra.cloud/dashboard").unwrap(), &c));
        assert!(!is_sign_in_page(&Url::parse("https://evil.example/sign-in").unwrap(), &c));
    }
}
