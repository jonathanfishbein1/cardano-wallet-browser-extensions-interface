import * as CSL from '@emurgo/cardano-serialization-lib-browser'
import { Buffer } from 'buffer'

const hexToBytes = string => Buffer.from(string, 'hex'),
    hexToBech32 = address => CSL.Address.from_bytes(hexToBytes(address)).to_bech32()

const TX = {
    too_big: 'Transaction too big'
}

const supportedWallets = [
    'nami',
    'eternl',
    'yoroi',
    'flint',
    'typhon',
    'gero',
]

const getCollateral = async wallet => {
    const collateral = ("Nami" === wallet.name) ?
        wallet.experimental.getCollateral()
        :
        wallet.getCollateral()
    return await collateral.then(utxoRefs =>
        utxoRefs.map(utxoRef => CSL.TransactionUnspentOutput.from_bytes(Buffer.from(utxoRef, "hex")))
    )
}

const getRewardAddress = async wallet => {
    return await ('Typhon Wallet' === wallet.name) ?
        wallet.getRewardAddress().then(response => response.data)
        :
        wallet.getRewardAddresses().then(rewardAddress => hexToBech32(rewardAddress[0]))
}

const getStakeKeyHash = async wallet => {
    const rewardAddress = await getRewardAddress(wallet)
    return CSL.RewardAddress.from_address(
        CSL.Address.from_bech32(rewardAddress)
    )?.payment_cred().to_keyhash()?.to_bytes()
}

const getChangeAddress = async wallet => {
    return await ('Typhon Wallet' === wallet.name) ?
        wallet.getAddress().then(response => response.data)
        :
        wallet.getChangeAddress().then(changeAddress => hexToBech32(changeAddress))
}


const getUtxos = async wallet => {
    return await ('Typhon Wallet' === wallet.name) ?
        []
        :
        wallet.getUtxos().then(rawUtxos => rawUtxos.map(utxo => CSL.TransactionUnspentOutput.from_bytes(hexToBytes(utxo))))
}

const delegateTo = async (wallet, poolId, protocolParameters, account) => {
    if ('Typhon Wallet' === wallet.name) {
        const { status, data, error, reason } = await wallet.delegationTransaction({
            poolId,
        })
        return status ? data.transactionId : { error, reason }
    }
    else {
        const changeAddress = await getChangeAddress(wallet)
            , utxos = await getUtxos(wallet)
            , outputs = CSL.TransactionOutputs.new()
        outputs.add(
            CSL.TransactionOutput.new(
                CSL.Address.from_bech32(changeAddress),
                CSL.Value.new(CSL.BigNum.from_str(protocolParameters.key_deposit))
            )
        )
        const stakeKeyHash = await getStakeKeyHash(wallet)
            , certificates = CSL.Certificates.new()
            , stakeCredential = CSL.StakeCredential.from_keyhash(
                CSL.Ed25519KeyHash.from_bytes(
                    hexToBytes(stakeKeyHash)
                )
            )
            , poolKeyHash = CSL.Ed25519KeyHash.from_bytes(
                hexToBytes(poolId)
            )
            , stakeDelegation = CSL.StakeDelegation.new(
                stakeCredential,
                poolKeyHash
            )
            , certificate = CSL.Certificate.new_stake_delegation(
                stakeDelegation
            )
        if (!account.active) {
            certificates.add(
                CSL.Certificate.new_stake_registration(
                    CSL.StakeRegistration.new(
                        stakeCredential
                    )
                )
            )
            certificates.add(certificate)
        }
        else
            certificates.add(certificate)

        const linearFee = CSL.LinearFee.new(
            CSL.BigNum.from_str(protocolParameters.min_fee_a.toString()),
            CSL.BigNum.from_str(protocolParameters.min_fee_b.toString())
        )
            , transactionBuilderConfig = CSL.TransactionBuilderConfigBuilder.new()
                .fee_algo(linearFee)
                .pool_deposit(CSL.BigNum.from_str(protocolParameters.pool_deposit))
                .key_deposit(CSL.BigNum.from_str(protocolParameters.key_deposit))
                .max_value_size(protocolParameters.max_val_size)
                .max_tx_size(protocolParameters.max_tx_size)
                .coins_per_utxo_word(CSL.BigNum.from_str(protocolParameters.coins_per_utxo_word))
                .build()
            , txBuilder = CSL.TransactionBuilder.new(
                transactionBuilderConfig
            )

        txBuilder.set_certs(certificates)
        const utxosPlural = CSL.TransactionUnspentOutputs.new()
        utxos.map(utxo => utxosPlural.add(utxo))
        txBuilder.add_inputs_from(utxosPlural, CSL.CoinSelectionStrategyCIP2.RandomImprove)
        txBuilder.add_change_if_needed(CSL.Address.from_bech32(changeAddress))


        const transaction = CSL.Transaction.new(txBuilder.build(), CSL.TransactionWitnessSet.new())
        const signedTransaction = await signTx(wallet, transaction)
        return await submitTx(wallet, signedTransaction)
    }
}



const buy = async (wallet, protocolParameters, account, payToAddress, amount, addressScriptBech32) => {

    if ('Typhon Wallet' === wallet.name) {
        const typhonPayment = await wallet.paymentTransaction({
            outputs: [{
                payToAddress,
                amount,
            }],
        })
    }
    else {
        const changeAddress = await getChangeAddress(wallet)
            , utxos = await getUtxos(wallet)
        const datum = CSL.PlutusData.new_integer(CSL.BigInt.from_str("0"))
        const dataHash = CSL.hash_plutus_data(datum)
        const datums = CSL.PlutusList.new()
        datums.add(datum)

        const transactionOutputToSeller =
            CSL.TransactionOutputBuilder.new()
                .with_address(payToAddress)
                .next()
                .with_value(CSL.Value.new(CSL.BigNum.from_str(amount)))
                .build()

        const transactionOutputToScript =
            CSL.TransactionOutputBuilder.new()
                .with_address(addressScriptBech32)
                .with_data_hash(dataHash)
                .next()
                .with_value(CSL.Value.new(CSL.BigNum.from_str("2000000")))
                .build()


        const multiAsset = CSL.MultiAsset.new()
        const assets = CSL.Assets.new()
        assets.insert(CSL.AssetName.new(Buffer.from("43617264616e6961466f756e6465725768697465", "hex")),
            CSL.BigNum.from_str('1')
        )
        multiAsset.insert(CSL.ScriptHash.from_bytes(Buffer.from('641593ca39c5cbd3eb314533841d53e61ebf6ee7a0ec7c391652f31e')),
            assets)
        const transactionOutputToBuyer =
            CSL.TransactionOutputBuilder.new()
                .with_address(changeAddress)
                .next()
                .with_asset_and_min_required_coin(multiAsset, CSL.BigNum.from_str(protocolParameters.coins_per_utxo_word))
                .build()

        const transactionOutputs = CSL.TransactionOutputs.new()
        transactionOutputs.add(transactionOutputToSeller)
        transactionOutputs.add(transactionOutputToScript)
        transactionOutputs.add(transactionOutputToBuyer)
        const linearFee = CSL.LinearFee.new(
            CSL.BigNum.from_str(protocolParameters.min_fee_a.toString()),
            CSL.BigNum.from_str(protocolParameters.min_fee_b.toString())
        )
            , transactionBuilderConfig = CSL.TransactionBuilderConfigBuilder.new()
                .fee_algo(linearFee)
                .pool_deposit(CSL.BigNum.from_str(protocolParameters.pool_deposit))
                .key_deposit(CSL.BigNum.from_str(protocolParameters.key_deposit))
                .max_value_size(protocolParameters.max_val_size)
                .max_tx_size(protocolParameters.max_tx_size)
                .coins_per_utxo_word(CSL.BigNum.from_str(protocolParameters.coins_per_utxo_word))
                .build()
            , txBuilder = CSL.TransactionBuilder.new(
                transactionBuilderConfig
            )
        const utxosPlural = CSL.TransactionUnspentOutputs.new()
        utxos.map(utxo => utxosPlural.add(utxo))
        txBuilder.add_inputs_from(utxosPlural, CSL.CoinSelectionStrategyCIP2.RandomImprove)
        txBuilder.add_change_if_needed(CSL.Address.from_bech32(changeAddress))

        const txBody = txBuilder.build()
        const collateral = await getCollateral(wallet)
        const redeemers = CSL.Redeemers.new()
        const data = CSL.PlutusData.new_constr_plutus_data(CSL.ConstrPlutusData.new(CSL.BigNum.from_str('0'), CSL.PlutusList.new()))
        const redeemer = CSL.Redeemer.new(CSL.RedeemerTag.new_spend()
            , CSL.BigNum.from_str('0'), data, CSL.ExUnits.new(CSL.BigNum.from_str('7000000')
                , CSL.BigNum.from_str('3000000000')))
        redeemers.add(redeemer)

        const scripts = CSL.PlutusScripts.new()
        scripts.add(CSL.PlutusScript.from_bytes(Buffer.from("this.state.plutusScriptCborHex", "hex"))); //from cbor of plutus script

        const transactionWitnessSet = CSL.TransactionWitnessSet.new();

        transactionWitnessSet.set_plutus_scripts(scripts)
        transactionWitnessSet.set_plutus_data(datums)
        transactionWitnessSet.set_redeemers(redeemers)

        const cost_model_vals = [197209, 0, 1, 1, 396231, 621, 0, 1, 150000, 1000, 0, 1, 150000, 32, 2477736, 29175, 4, 29773, 100, 29773, 100, 29773, 100, 29773, 100, 29773, 100, 29773, 100, 100, 100, 29773, 100, 150000, 32, 150000, 32, 150000, 32, 150000, 1000, 0, 1, 150000, 32, 150000, 1000, 0, 8, 148000, 425507, 118, 0, 1, 1, 150000, 1000, 0, 8, 150000, 112536, 247, 1, 150000, 10000, 1, 136542, 1326, 1, 1000, 150000, 1000, 1, 150000, 32, 150000, 32, 150000, 32, 1, 1, 150000, 1, 150000, 4, 103599, 248, 1, 103599, 248, 1, 145276, 1366, 1, 179690, 497, 1, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 148000, 425507, 118, 0, 1, 1, 61516, 11218, 0, 1, 150000, 32, 148000, 425507, 118, 0, 1, 1, 148000, 425507, 118, 0, 1, 1, 2477736, 29175, 4, 0, 82363, 4, 150000, 5000, 0, 1, 150000, 32, 197209, 0, 1, 1, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 150000, 32, 3345831, 1, 1];

        const costModel = CSL.CostModel.new();
        cost_model_vals.forEach((x, i) => costModel.set(i, CSL.Int.new_i32(x)));


        const costModels = CSL.Costmdls.new();
        costModels.insert(CSL.Language.new_plutus_v1(), costModel);

        const scriptDataHash = CSL.hash_script_data(redeemers, costModels, datums);
        txBody.set_script_data_hash(scriptDataHash);

        txBody.set_collateral(collateral)


        const baseAddress = CSL.BaseAddress.from_address(changeAddress)
        const requiredSigners = CSL.Ed25519KeyHashes.new()
        if (baseAddress !== undefined) {
            const baseAddressPaymentPubKeyHash = baseAddress.payment_cred().to_keyhash()
            if (baseAddressPaymentPubKeyHash !== undefined)
                requiredSigners.add(baseAddressPaymentPubKeyHash)
        }

        txBody.set_required_signers(requiredSigners);

        const tx = CSL.Transaction.new(
            txBody,
            CSL.TransactionWitnessSet.from_bytes(transactionWitnessSet.to_bytes())
        )
        const txBytes = tx.to_bytes()
        const thing = Buffer.from(txBytes).toString("hex")
        let txVkeyWitnesses = await wallet.signTx(thing, true);
        txVkeyWitnesses = CSL.TransactionWitnessSet.from_bytes(Buffer.from(txVkeyWitnesses, "hex"));

        transactionWitnessSet.set_vkeys(txVkeyWitnesses.vkeys());

        const transaction = CSL.Transaction.new(txBody, CSL.TransactionWitnessSet.new())
        const signedTransaction = await signTx(wallet, transaction)
        return await submitTx(wallet, signedTransaction)

    }
}
const signTx = async (wallet, transaction) => {
    return wallet.signTx(hexToBytes(transaction.to_bytes()).toString('hex')).then(witnesses => {
        return CSL.Transaction.new(
            transaction.body(),
            CSL.TransactionWitnessSet.from_bytes(hexToBytes(witnesses))
        )
    }
    )
}


const submitTx = async (wallet, signedTransaction) => await wallet.submitTx(hexToBytes(signedTransaction.to_bytes()).toString('hex'))


declare var window: any
const getWalletApi = async namespace => {
    return await ('typhon' === namespace) ?
        window.cardano[namespace]
        :
        window.cardano[namespace].enable()
}


const isSupported = type => supportedWallets.includes(type)

const hasWallet = type => isSupported(type) && window.cardano[type.toLowerCase()] !== undefined

const getWallet = async type => await getWalletApi(type.toLowerCase())

export { CSL }
export {
    hasWallet, getWallet, getRewardAddress,
    delegateTo, getCollateral
}
