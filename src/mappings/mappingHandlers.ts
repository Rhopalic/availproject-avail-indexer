import { EventRecord, Digest, Header, AccountId } from "@polkadot/types/interfaces"
import { SubstrateExtrinsic, SubstrateBlock } from "@subql/types";
import { Event, Extrinsic, EventDescription, ExtrinsicDescription, SpecVersion, Block, Session, Log, HeaderExtension, Commitment, AppLookup } from "../types";
import { checkIfExtrinsicExecuteSuccess, getFees, shouldGetFees } from "../utils/extrinsic";
import { wrapExtrinsics, roundPrice } from "../utils";
import { transferHandler, updateAccounts } from "../utils/balances";
import { extractAuthor } from "../utils/author";

let specVersion: SpecVersion;

export async function handleBlock(block: SubstrateBlock): Promise<void> {
  try {
    const blockNumber = block.block.header.number.toNumber()
    if (blockNumber % 100 === 0) logger.info("Handling block with specversion " + block.specVersion)
    const dbBlock = await Block.get(blockNumber.toString())
    if (!dbBlock) {
      await blockHandler(block, specVersion)
      const wrappedExtrinsics = wrapExtrinsics(block)
      const calls = wrappedExtrinsics.map((ext, idx) => handleCall(`${blockNumber.toString()}-${idx}`, ext));
      const events = block.events.map((evt, idx) => {
        const relatedExtrinsicIndex = evt.phase.isApplyExtrinsic ? evt.phase.asApplyExtrinsic.toNumber() : -1
        return handleEvent(blockNumber.toString(), idx, evt, relatedExtrinsicIndex, block.block.header.hash.toString(), block.timestamp)
      });
      await Promise.all([
        store.bulkCreate('Event', await Promise.all(events)),
        store.bulkCreate('Extrinsic', await Promise.all(calls))
      ]);
    }
  } catch (err) {
    logger.error(`record block error at :  and block nb ${block.block.header.number.toNumber()}`);
  }
}

export const blockHandler = async (block: SubstrateBlock, specVersion: SpecVersion): Promise<void> => {
  try {
    const blockHeader = block.block.header
    const blockExtrinsics = block.block.extrinsics
    // if (blockHeader.number.toNumber() % 100 === 0) logger.info(`Time ${blockHeader.number.toString()}: ${new Date()}`);
    const blockRecord = new Block(
      blockHeader.number.toString(),
      blockHeader.number.toNumber(),
      blockHeader.hash.toString(),
      block.timestamp,
      blockHeader.parentHash.toString(),
      blockHeader.stateRoot.toString(),
      blockHeader.extrinsicsRoot.toString(),
      block.specVersion,
      blockExtrinsics.length,
      false
    )
    await Promise.all([
      handleLogs(blockHeader.number.toString(), blockHeader.digest),
      updateSession(blockRecord, blockHeader.digest),
      updateSpecversion(specVersion, block.specVersion, blockHeader.number.toBigInt()),
      handleExtension(blockHeader)
    ])
    await blockRecord.save()
  } catch (err) {
    logger.error('record block error:' + block.block.header.number.toNumber());
    logger.error('record block error detail:' + err);
  }
}

export async function handleCall(idx: string, extrinsic: SubstrateExtrinsic): Promise<Extrinsic> {
  try {
    const block = extrinsic.block
    const ext = extrinsic.extrinsic
    const methodData = ext.method
    const documentation = ext.meta.docs ? ext.meta.docs : JSON.parse(JSON.stringify(ext.meta)).documentation

    let descriptionRecord = await ExtrinsicDescription.get(`${methodData.section}_${methodData.method}`)
    if (!descriptionRecord) {
      descriptionRecord = new ExtrinsicDescription(
        `${methodData.section}_${methodData.method}`,
        methodData.section,
        methodData.method,
        JSON.stringify(documentation.map((d: any) => d.toString()).join('\n'))
      )
      await descriptionRecord.save()
      logger.info('new extrinsic description recorded')
    }

    const extrinsicRecord = new Extrinsic(
      idx,
      block.block.header.number.toString(),
      ext.hash.toString(),
      methodData.section,
      methodData.method,
      block.block.header.number.toBigInt(),
      checkIfExtrinsicExecuteSuccess(extrinsic),
      ext.isSigned,
      extrinsic.idx,
      ext.hash.toString(),
      block.timestamp,
      descriptionRecord.id,
      ext.signer.toString(),
      ext.signature.toString(),
      ext.nonce.toNumber(),
      methodData.meta.args.map(a => a.name.toString()),
      methodData.args.map((a) => a.toString()),
      extrinsic.events.length
    );
    extrinsicRecord.fees = shouldGetFees(extrinsicRecord.module) ? await getFees(ext.toHex(), block.block.header.hash.toHex()) : ""
    extrinsicRecord.feesRounded = extrinsicRecord.fees ? roundPrice(extrinsicRecord.fees) : undefined
    return extrinsicRecord
  } catch (err: any) {
    logger.error(`record extrinsic error at : hash(${extrinsic.extrinsic.hash}) and block nb ${extrinsic.block.block.header.number.toNumber()}`);
    logger.error('record extrinsic error detail:' + err);
    if (err.sql) logger.error('record extrinsic error sql detail:' + err.sql);
    throw err
  }
}

export async function handleEvent(blockNumber: string, eventIdx: number, event: EventRecord, extrinsicId: number, blockHash: string, timestamp: Date): Promise<Event> {
  try {
    const eventData = event.event
    const documentation = eventData.meta.docs ? eventData.meta.docs : JSON.parse(JSON.stringify(eventData.meta)).documentation
    let descriptionRecord = await EventDescription.get(`${eventData.section}_${eventData.method}`)
    if (!descriptionRecord) {
      descriptionRecord = new EventDescription(
        `${eventData.section}_${eventData.method}`,
        eventData.section,
        eventData.method,
        JSON.stringify(documentation.map((d: any) => d.toString()).join('\n'))
      )
      await descriptionRecord.save()
      logger.info('new event description recorded')
    }

    const newEvent = new Event(
      `${blockNumber}-${eventIdx}`,
      blockNumber.toString(),
      eventData.section,
      eventData.method,
      BigInt(blockNumber),
      eventIdx,
      eventData.method,
      descriptionRecord.id,
      eventData.meta.args.map(a => a.toString()),
      eventData.data.map(a => JSON.stringify(a).indexOf('u0000') === -1 ?
        a.toString()
        :
        JSON.stringify(a).split("u0000").join('')
          .split("\\").join('')
          .split("\"").join('')
      ),
    );
    if (extrinsicId !== -1) newEvent.extrinsicId = `${blockNumber}-${extrinsicId}`

    await handleAccountsAndTransfers(event, blockNumber, blockHash, timestamp, newEvent.extrinsicId || "")

    return newEvent;
  } catch (err) {
    logger.error('record event error at block number:' + blockNumber.toString());
    logger.error('record event error detail:' + err);
    throw err
  }
}

export const handleLogs = async (blockNumber: string, digest: Digest) => {
  for (const [i, log] of digest.logs.entries()) {
    let engine: string | undefined = undefined
    let data = ""

    if (log.isConsensus) {
      engine = log.asConsensus[0].toString()
      data = log.asConsensus[1].toString()
    }
    else if (log.isSeal) {
      engine = log.asSeal[0].toString()
      data = log.asSeal[1].toString()
    }
    else if (log.isPreRuntime) {
      engine = log.asPreRuntime[0].toString()
      data = log.asPreRuntime[1].toString()
    }
    else if (log.isOther) data = log.asOther.toString()
    else if (log.isAuthoritiesChange) data = log.asAuthoritiesChange.toString()
    else if (log.isChangesTrieRoot) data = log.asAuthoritiesChange.toString()

    await saveLog(blockNumber, i, log.type, engine, data)
  }
}

export const saveLog = async (blockNumber: string, index: number, type: string, engine: string | undefined, data: string) => {
  const logRecord = new Log(
    `${blockNumber}-${index}`,
    blockNumber,
    type,
    data
  )
  if (engine) logRecord.engine = engine
  await logRecord.save()
}

export const updateSession = async (blockRecord: Block, digest: Digest) => {
  try {
    const sessionId = await api.query.session.currentIndex()
    let sessionRecord = await Session.get(sessionId.toString())
    if (!sessionRecord) {
      const validators = (await api.query.session.validators()) as unknown as string[]
      sessionRecord = new Session(sessionId.toString(), validators.map(x => x.toString()))
      await sessionRecord.save()
    }
    blockRecord.sessionId = Number(sessionRecord.id)
    const author = extractAuthor(digest, sessionRecord.validators as unknown as AccountId[])
    blockRecord.author = author ? author.toString() : undefined
  } catch (err) {
    logger.error('update session error');
    logger.error('update session error detail:' + err);
  }
}

export const updateSpecversion = async (specVersion: SpecVersion, blockSpecVersion: number, blockNumber: bigint) => {
  if (!specVersion) {
    let dbSpec = await SpecVersion.get(blockSpecVersion.toString());
    if (dbSpec) specVersion = dbSpec
  }
  if (!specVersion || specVersion.id !== blockSpecVersion.toString()) {
    specVersion = new SpecVersion(blockSpecVersion.toString(), blockNumber);
    await specVersion.save();
  }
}

export const handleExtension = async (blockHeader: Header) => {
  const blockNumber = blockHeader.number.toString()
  const blockHeaderUnsafe = blockHeader as any
  if (blockHeaderUnsafe.extension) {
    const extension = JSON.parse(blockHeaderUnsafe.extension)

    // Create extension
    const headerExtensionRecord = new HeaderExtension(
      blockNumber,
      blockNumber
    )
    let data: any = undefined
    if (extension.v1 !== undefined) {
      headerExtensionRecord.version = "v1"
      data = extension.v1
    }
    if (extension.v2 !== undefined) {
      headerExtensionRecord.version = "v2"
      data = extension.v2
    }
    await headerExtensionRecord.save()

    // Create commitment
    const commitmentRecord = new Commitment(
      blockNumber,
      blockNumber,
      headerExtensionRecord.id
    )
    commitmentRecord.rows = data.commitment.rows
    commitmentRecord.cols = data.commitment.cols
    commitmentRecord.dataRoot = data.commitment.dataRoot
    commitmentRecord.commitment = data.commitment.commitment
    await commitmentRecord.save()

    // Create app lookup
    const appLookupRecord = new AppLookup(
      blockNumber,
      blockNumber,
      headerExtensionRecord.id
    )
    appLookupRecord.size = data.appLookup.size
    appLookupRecord.index = JSON.stringify(data.appLookup.index)
    await appLookupRecord.save()
  }
}

export const handleAccountsAndTransfers = async (event: EventRecord, blockId: string, blockHash: string, timestamp: Date, extrinsicIndex: string) => {
  const balanceEvents = [
    "balances.BalanceSet",
    "balances.Deposit",
    "balances.DustLost",
    "balances.Endowed",
    "balances.Reserved",
    "balances.Slashed",
    "balances.Unreserved",
    "balances.Withdraw",
  ]
  const feeEvents = ["transactionPayment.TransactionFeePaid"]
  const transferEvents = ["balances.Transfer"]

  const key = `${event.event.section}.${event.event.method}`

  if ([...balanceEvents, ...feeEvents].includes(key)) {
    const [who] = event.event.data
    await updateAccounts([who.toString()])
  }

  if (transferEvents.includes(key)) {
    await transferHandler(event, blockId, blockHash, timestamp, extrinsicIndex)
  }
}