import * as CSL from '@emurgo/cardano-serialization-lib-browser'
import { Buffer } from 'buffer'
import CoinSelection from './lib/coinSelection'

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
                CSL.Value.new(CSL.BigNum.from_str(protocolParameters.keyDeposit))
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

        const transaction = await buildTx(changeAddress, utxos, outputs, protocolParameters, certificates, false)
            , signedTransaction = await signTx(wallet, transaction)
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
            , outputs = CSL.TransactionOutputs.new()
        outputs.add(
            CSL.TransactionOutput.new(
                CSL.Address.from_bech32(payToAddress),
                CSL.Value.new(CSL.BigNum.from_str(amount))
            )
        )
        const dataHash = CSL.hash_plutus_data(CSL.PlutusData.new_integer(CSL.BigInt.from_str("0")))

        outputs.add(
            CSL.TransactionOutput.new(
                CSL.Address.from_bech32(addressScriptBech32),
                CSL.Value.new(CSL.BigNum.from_str(amount)),
            )
        )




        const transaction = await buildTx(changeAddress, utxos, outputs, protocolParameters, undefined, true)
            , signedTransaction = await signTx(wallet, transaction)
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

export const buildTx = async (changeAddress, utxos, outputs, protocolParameters, certificates?, hasDataHash?) => {
    const linearFee = CSL.LinearFee.new(
        CSL.BigNum.from_str(protocolParameters.minFeeA.toString()),
        CSL.BigNum.from_str(protocolParameters.minFeeB.toString())
    )
        , transactionBuilderConfig = CSL.TransactionBuilderConfigBuilder.new()
            .fee_algo(linearFee)
            .pool_deposit(CSL.BigNum.from_str(protocolParameters.poolDeposit))
            .key_deposit(CSL.BigNum.from_str(protocolParameters.keyDeposit))
            .max_value_size(protocolParameters.maxValSize)
            .max_tx_size(protocolParameters.maxTxSize)
            .coins_per_utxo_word(CSL.BigNum.from_str(protocolParameters.coinsPerUtxoWord))
            .build()
        //.ex_unit_prices(CSL.ExUnitPrices.new())
        , txBuilder = CSL.TransactionBuilder.new(
            transactionBuilderConfig
        )
    if (certificates)
        txBuilder.set_certs(certificates)
    const inputBuilder = CSL.TxInputsBuilder.new()

    txBuilder.set_inputs(inputBuilder)
    txBuilder.add_output(outputs.get(0))
    const utxosPlural = CSL.TransactionUnspentOutputs.new()
    utxos.map(utxo => utxosPlural.add(utxo))
    txBuilder.add_inputs_from(utxosPlural, CSL.CoinSelectionStrategyCIP2.RandomImprove)
    txBuilder.add_change_if_needed(CSL.Address.from_bech32(changeAddress))
    const transaction = CSL.Transaction.new(txBuilder.build(), CSL.TransactionWitnessSet.new())
        , size = transaction.to_bytes().length * 2
    if (size > protocolParameters.maxTxSize) throw TX.too_big
    return transaction
}

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
