//! Sandbox-only MPC stand-in for the NEAR Chain Signatures signer.
//! Never deployed outside near-workspaces tests.

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct MockSigner {}

#[near]
impl MockSigner {
    /// Contract code version.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_package_version() {
        assert_eq!(MockSigner::default().version(), env!("CARGO_PKG_VERSION"));
    }
}
