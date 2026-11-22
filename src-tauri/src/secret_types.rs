use std::fmt;
use zeroize::Zeroizing;

/// A secret string (cookie, password). Zeroed on drop, never printed.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Self(Zeroizing::new(s.into()))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// Argon2id parameters stored next to a master-password vault.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kdf {
    pub salt: Vec<u8>,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}
