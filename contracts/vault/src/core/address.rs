//! SegWit address validation and output scripts. Pure: no `env`.

use super::errors::{CoreResult, ErrorCode, Rejection};
use super::policy::BtcNetwork;
use bech32::{segwit, Fe32, Hrp};
use sha2::{Digest, Sha256};

const fn hrp_for(network: BtcNetwork) -> Hrp {
    match network {
        BtcNetwork::Bitcoin => bech32::hrp::BC,
        BtcNetwork::Signet | BtcNetwork::Testnet4 => bech32::hrp::TB,
        BtcNetwork::Regtest => bech32::hrp::BCRT,
    }
}

/// Decodes a SegWit address (v0 or v1, valid checksum, the network's HRP) into its output
/// script: `OP_n <program>`.
pub fn script_pubkey(address: &str, network: BtcNetwork) -> CoreResult<Vec<u8>> {
    let reject = || Rejection::with(ErrorCode::BadAddress, address);
    let (hrp, version, program) = segwit::decode(address).map_err(|_| reject())?;
    if hrp != hrp_for(network) {
        return Err(reject());
    }
    let version = version.to_u8();
    if version > 1 {
        return Err(reject());
    }
    let opcode = if version == 0 { 0x00 } else { 0x50 + version };
    let mut script = Vec::with_capacity(2 + program.len());
    script.push(opcode);
    script.push(u8::try_from(program.len()).map_err(|_| reject())?);
    script.extend_from_slice(&program);
    Ok(script)
}

/// P2WSH address of a witness script on the given network.
pub fn p2wsh_address(script: &[u8], network: BtcNetwork) -> String {
    let program = Sha256::digest(script);
    segwit::encode(hrp_for(network), Fe32::Q, &program)
        .expect("a 32-byte v0 program is always encodable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_bip173_p2wsh_vectors() {
        let script = script_pubkey(
            "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
            BtcNetwork::Signet,
        )
        .unwrap();
        assert_eq!(script[0..2], [0x00, 0x20]);
        assert_eq!(script.len(), 34);
        let mainnet = script_pubkey(
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            BtcNetwork::Bitcoin,
        )
        .unwrap();
        assert_eq!(mainnet[0..2], [0x00, 0x14]);
    }

    #[test]
    fn accepts_taproot() {
        let script = script_pubkey(
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
            BtcNetwork::Bitcoin,
        )
        .unwrap();
        assert_eq!(script[0..2], [0x51, 0x20]);
    }

    #[test]
    fn rejects_wrong_network_and_bad_checksum() {
        let signet = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
        assert!(script_pubkey(signet, BtcNetwork::Bitcoin).is_err());
        assert!(script_pubkey(signet, BtcNetwork::Regtest).is_err());
        let corrupted = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8";
        assert_eq!(
            script_pubkey(corrupted, BtcNetwork::Signet)
                .unwrap_err()
                .code,
            ErrorCode::BadAddress
        );
        assert!(script_pubkey("not an address", BtcNetwork::Signet).is_err());
    }
}
