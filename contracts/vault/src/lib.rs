//! Morrow Vault Contract: co-signs Bitcoin spends through NEAR Chain Signatures,
//! only within the Vault's Policy.

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct VaultContract {}

#[near]
impl VaultContract {
    /// Contract code version, shown on the Proof Page.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_package_version() {
        assert_eq!(
            VaultContract::default().version(),
            env!("CARGO_PKG_VERSION")
        );
    }
}
