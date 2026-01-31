import { ETHERSCAN_BASE_URL } from '@buildeross/constants/etherscan'
import { useEnsData } from '@buildeross/hooks/useEnsData'
import { useVotes } from '@buildeross/hooks/useVotes'
import { useChainStore, useDaoStore, useProposalStore } from '@buildeross/stores'
import { AddressType, TokenMetadata, TransactionType } from '@buildeross/types'
import { ContractButton } from '@buildeross/ui/ContractButton'
import { lockupAbi, StreamStatus } from '@buildeross/utils/sablier/constants'
import {
  calculateStreamTimes,
  createSablierStreamUrl,
  formatStreamDuration,
  getStatusLabel,
  StreamConfigDurations,
  StreamConfigTimestamps,
  StreamLiveData,
} from '@buildeross/utils/sablier/streams'
import { atoms, Box, Button, Icon, Stack, Text } from '@buildeross/zord'
import { useCallback, useMemo } from 'react'
import { Address, encodeFunctionData, formatUnits, isAddressEqual } from 'viem'
import { useAccount, useConfig } from 'wagmi'
import { simulateContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'

interface StreamItemProps {
  stream: StreamConfigDurations | StreamConfigTimestamps
  index: number
  isDurationsMode: boolean
  liveData: StreamLiveData | null
  streamId: bigint | null
  isExecuted: boolean
  tokenMetadata?: TokenMetadata
  lockupAddress: Address | null
  withdrawingStreamId: bigint | null
  setWithdrawingStreamId: (id: bigint | null) => void
  cancelingStreamId: bigint | null
  setCancelingStreamId: (id: bigint | null) => void
  onOpenProposalReview: () => Promise<void>
  refetchLiveData: () => Promise<unknown>
}

/**
 * Factory function that creates an accordion item configuration for a Sablier stream.
 *
 * Note: Although this uses React hooks, it is NOT a traditional React component.
 * It returns a plain object with { title, description } to be used in the Accordion
 * component's items prop. The name starts with uppercase to satisfy React's rules of hooks.
 *
 * @returns Accordion item config object with title and description JSX
 */
export const CreateStreamItem = ({
  stream,
  index,
  isDurationsMode,
  liveData,
  streamId,
  isExecuted,
  tokenMetadata,
  lockupAddress,
  withdrawingStreamId,
  setWithdrawingStreamId,
  cancelingStreamId,
  setCancelingStreamId,
  onOpenProposalReview,
  refetchLiveData,
}: StreamItemProps): { title: React.ReactElement; description: React.ReactElement } => {
  const { chain } = useChainStore()
  const { addresses } = useDaoStore()
  const { addTransaction } = useProposalStore()
  const { address } = useAccount()
  const config = useConfig()

  const { hasThreshold } = useVotes({
    chainId: chain.id,
    governorAddress: addresses.governor,
    signerAddress: address,
    collectionAddress: addresses.token,
  })

  const { displayName: recipientName } = useEnsData(stream.recipient)

  const { startTime, cliffTime, endTime } = useMemo(
    () =>
      liveData
        ? {
            startTime: liveData.startTime,
            cliffTime: liveData.cliffTime,
            endTime: liveData.endTime,
          }
        : calculateStreamTimes(stream, isDurationsMode),
    [liveData, stream, isDurationsMode]
  )

  const decimals = tokenMetadata?.decimals ?? 18
  const totalAmount = stream.depositAmount
  const totalAmountDisplay = tokenMetadata?.symbol
    ? `${formatUnits(totalAmount, decimals)} ${tokenMetadata.symbol}`
    : totalAmount.toString()

  const duration = endTime - startTime
  const hasCliff = cliffTime > 0

  const isRecipient = address && isAddressEqual(stream.recipient, address)
  const isSender =
    address &&
    (isAddressEqual(liveData?.sender ?? stream.sender, address) ||
      isAddressEqual(stream.sender, address))
  const isSenderTreasury =
    addresses.treasury &&
    (isAddressEqual(liveData?.sender ?? stream.sender, addresses.treasury) ||
      isAddressEqual(stream.sender, addresses.treasury))

  const handleWithdraw = useCallback(async () => {
    if (!lockupAddress || !address || !liveData) return

    try {
      setWithdrawingStreamId(liveData.streamId)
      const data = await simulateContract(config, {
        address: lockupAddress,
        abi: lockupAbi,
        functionName: 'withdrawMax',
        args: [liveData.streamId, address],
        value: liveData.minFeeWei,
      })

      const txHash = await writeContract(config, data.request)
      await waitForTransactionReceipt(config, {
        hash: txHash,
        chainId: chain.id,
      })
      refetchLiveData()
    } catch (error) {
      console.error('Error withdrawing from stream:', error)
    } finally {
      setWithdrawingStreamId(null)
    }
  }, [
    config,
    chain.id,
    lockupAddress,
    address,
    liveData,
    setWithdrawingStreamId,
    refetchLiveData,
  ])

  const handleCancelDirect = useCallback(async () => {
    if (!lockupAddress || !liveData) return

    try {
      setCancelingStreamId(liveData.streamId)
      const data = await simulateContract(config, {
        address: lockupAddress,
        abi: lockupAbi,
        functionName: 'cancel',
        args: [liveData.streamId],
      })

      const txHash = await writeContract(config, data.request)
      await waitForTransactionReceipt(config, {
        hash: txHash,
        chainId: chain.id,
      })
    } catch (error) {
      console.error('Error canceling stream:', error)
    } finally {
      setCancelingStreamId(null)
    }
  }, [config, chain.id, lockupAddress, liveData, setCancelingStreamId])

  const handleCancelAsProposal = useCallback(async () => {
    if (!lockupAddress || !liveData) return

    const cancelTransaction = {
      target: lockupAddress as AddressType,
      functionSignature: 'cancel(uint256)',
      calldata: encodeFunctionData({
        abi: lockupAbi,
        functionName: 'cancel',
        args: [liveData.streamId],
      }),
      value: '',
    }

    const cancelTxnData = {
      type: TransactionType.CUSTOM,
      summary: `Cancel Sablier Stream #${liveData.streamId}`,
      transactions: [cancelTransaction],
    }

    addTransaction(cancelTxnData)
    onOpenProposalReview()
  }, [onOpenProposalReview, addTransaction, lockupAddress, liveData])

  return {
    title: <Text>{`Stream ${index + 1}: ${recipientName || stream.recipient}`}</Text>,
    description: (
      <Stack gap="x5">
        <Stack direction="row" align="center" justify="space-between">
          <Text variant="label-xs" color="tertiary">
            Total Amount: {totalAmountDisplay}
          </Text>
          <Text variant="label-xs" color="tertiary">
            Duration: {formatStreamDuration(duration)}
          </Text>
        </Stack>

        <Stack direction="row" align="center" justify="space-between">
          <Text variant="label-xs" color="tertiary">
            Start: {new Date(startTime * 1000).toLocaleDateString()}
          </Text>
          <Text variant="label-xs" color="tertiary">
            End: {new Date(endTime * 1000).toLocaleDateString()}
          </Text>
        </Stack>

        {hasCliff && (
          <Text variant="label-xs" color="tertiary">
            Cliff: {new Date(cliffTime * 1000).toLocaleDateString()}
          </Text>
        )}

        <Stack direction="row" gap="x2">
          {stream.cancelable && (
            <Box backgroundColor="background2" px="x2" py="x1" borderRadius="curved">
              <Text variant="label-xs">Cancelable</Text>
            </Box>
          )}
          {stream.transferable && (
            <Box backgroundColor="background2" px="x2" py="x1" borderRadius="curved">
              <Text variant="label-xs">Transferable</Text>
            </Box>
          )}
        </Stack>

        {liveData && (
          <>
            <Stack direction="column" gap="x2" mt="x3">
              <Text fontWeight="heading">Stream Status</Text>
              <Stack direction="row" align="center" justify="space-between">
                <Text variant="label-xs" color="tertiary">
                  Status:
                </Text>
                <Box
                  backgroundColor={
                    liveData.status === StreamStatus.STREAMING
                      ? 'positive'
                      : liveData.status === StreamStatus.CANCELED
                        ? 'negative'
                        : 'background2'
                  }
                  px="x2"
                  py="x1"
                  borderRadius="curved"
                >
                  <Text variant="label-xs" color="primary">
                    {getStatusLabel(liveData.status)}
                  </Text>
                </Box>
              </Stack>
              <Stack direction="row" align="center" justify="space-between">
                <Text variant="label-xs" color="tertiary">
                  Total Deposited:
                </Text>
                <Text variant="label-xs">
                  {formatUnits(liveData.depositedAmount, decimals)}{' '}
                  {tokenMetadata?.symbol}
                </Text>
              </Stack>
              <Stack direction="row" align="center" justify="space-between">
                <Text variant="label-xs" color="tertiary">
                  Already Withdrawn:
                </Text>
                <Text variant="label-xs">
                  {formatUnits(liveData.withdrawnAmount, decimals)}{' '}
                  {tokenMetadata?.symbol}
                </Text>
              </Stack>
              <Stack direction="row" align="center" justify="space-between">
                <Text variant="label-xs" color="tertiary">
                  Currently Withdrawable:
                </Text>
                <Text variant="label-xs" fontWeight="heading">
                  {formatUnits(liveData.withdrawableAmount, decimals)}{' '}
                  {tokenMetadata?.symbol}
                </Text>
              </Stack>
              <Stack direction="row" align="center" justify="space-between">
                <Text variant="label-xs" color="tertiary">
                  Remaining:
                </Text>
                <Text variant="label-xs">
                  {formatUnits(
                    liveData.depositedAmount - liveData.withdrawnAmount,
                    decimals
                  )}{' '}
                  {tokenMetadata?.symbol}
                </Text>
              </Stack>
            </Stack>

            {/* Withdraw button for recipient */}
            {isRecipient &&
              liveData.withdrawableAmount > 0n &&
              !liveData.wasCanceled &&
              !liveData.isDepleted && (
                <ContractButton
                  chainId={chain.id}
                  variant="primary"
                  handleClick={() => handleWithdraw()}
                  disabled={withdrawingStreamId === liveData.streamId}
                  loading={withdrawingStreamId === liveData.streamId}
                >
                  Withdraw Available Funds
                </ContractButton>
              )}

            {/* Cancel button for sender */}
            {stream.cancelable &&
              !liveData.wasCanceled &&
              !liveData.isDepleted &&
              liveData.status !== StreamStatus.SETTLED && (
                <>
                  {isSender && (
                    <ContractButton
                      chainId={chain.id}
                      variant="destructive"
                      handleClick={handleCancelDirect}
                      disabled={cancelingStreamId === liveData.streamId}
                      loading={cancelingStreamId === liveData.streamId}
                    >
                      Cancel Stream
                    </ContractButton>
                  )}
                  {isSenderTreasury && !isSender && (
                    <Stack direction="column" gap="x1">
                      <Text variant="label-xs" color="tertiary">
                        Create a proposal to cancel this stream
                      </Text>
                      <ContractButton
                        chainId={chain.id}
                        variant="destructive"
                        handleClick={handleCancelAsProposal}
                        disabled={!hasThreshold}
                      >
                        Create Proposal to Cancel
                      </ContractButton>
                      {!hasThreshold && (
                        <Text variant="label-xs" color="negative">
                          You do not have enough votes to create a proposal
                        </Text>
                      )}
                    </Stack>
                  )}
                </>
              )}

            {/* Link to Sablier app */}
            {streamId && (
              <Button
                as="a"
                variant="secondary"
                size="sm"
                target="_blank"
                rel="noreferrer"
                href={createSablierStreamUrl(chain.id, streamId)}
              >
                View on Sablier
                <Icon id="arrowTopRight" />
              </Button>
            )}
          </>
        )}

        {/* Links before execution */}
        {!isExecuted && (
          <Stack direction="column" gap="x2" mt="x3">
            <Text variant="label-sm" color="tertiary">
              Stream will be created when proposal is executed
            </Text>
            <Box color={'secondary'} className={atoms({ textDecoration: 'underline' })}>
              <a
                href={`${ETHERSCAN_BASE_URL[chain.id]}/address/${stream.recipient}`}
                rel="noreferrer"
                target="_blank"
              >
                <Text variant="label-sm">View Recipient on Etherscan</Text>
              </a>
            </Box>
          </Stack>
        )}
      </Stack>
    ),
  }
}
