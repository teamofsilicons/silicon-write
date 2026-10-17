//! Random, URL-safe ids with a kind prefix (`d_` docs, `f_` folders, …).

use rand::RngExt;

const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

pub fn new_id(prefix: &str) -> String {
    let mut rng = rand::rng();
    let body: String = (0..20).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect();
    format!("{prefix}_{body}")
}

/// A random Yjs client id (31 bits, the range Yjs clients use).
pub fn new_client_id() -> u64 {
    rand::rng().random_range(1..(1u64 << 31))
}
