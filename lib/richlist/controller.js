'use strict';

const EventEmitter = require('events');
const MemoryStorage = require('./storage/memory');

const Stopped = 0;
const Running = 1;
const WaitingBlocks = 2;
const Stopping = 3;

const InvalidBlockError = new Error('block not valid');
const AlreadyLatestBlockError = new Error('already latest block');
const blacklist = ["XbhJHb8ggRJa3uCg6Xn8NPi95eFVnXpUi4",
                                   "XuUpAB7eUAtDKTfocxjKf6aNWrKczrjS2b",
                                   "XrVJqBuaXrmWZNSJA35VtzYruqSzE98Ebq",
                                   "XtTkjJ25FGD7VSGxEhrjhix1Cmf37P5oUP",
                                   "XarsvJB6GBdHQVrxo1nmLARggzZmiPHAMt",
                                   "XjM4SM9VY5NE7GosPn87j7Nhm42woYPXPz",
                                   "XppAPYHhnE4oboS4iL5QeNphW4em72NBwJ",
                                   "XqXZJhpJNfrYpgbM3HpsV1SZmH8NfwZLg3",
                                   "Xeyz82zoXGYB4ow1QksFtiZxe3qXDq2Uj6"
                                  ];

class RichListController extends EventEmitter {
    /**
     * @param {object} options require node and storage is optional
     */
    constructor(options) {
        super();

        this.node = options.node;
        this.state = Stopped;
        this.emitter = new EventEmitter();

        if (options.storage) {
            this.storage = options.storage;
        } else {
            this.storage = new MemoryStorage();
        }

        this.startScanBlocks = this.startScanBlocks.bind(this); // we need this to be able to pass startScanBlocks as a callback directly
    }

    init() {
        this.state = Running;
        this.startScanBlocks();

        return Promise.resolve();
    }

    list(req, res) {
        this.storage.getMostRichest(108).then(list => {
            if (list) {
                res.jsonp(list.filter(e => !blacklist.includes(e.address)));
            }
        });
    }

    stop() {
        return new Promise((resolve, reject) => {
            let previousState = this.state;

            // initiat stopping
            this.state = Stopping;
            this.emitter.once('stopped', resolve);

            // check if scanning loop already completed and waiting for a new block
            if (previousState === WaitingBlocks) {
                this.startScanBlocks();
            }
        });
    }

    startScanBlocks() {
        // check if stopping request
        if (this.state === Stopping) {
            this.state = Stopped;
            this.node.services.helpd.removeListener('block', this.startScanBlocks);
            this.emitter.emit('stopped');
            return;
        }

        // start blocks scanning loop
        this.state = Running;

        this.storage.getLatestBlock().then(local => {
            // check if latest local block still on the chain
            return new Promise((resolve, reject) => {
                this.node.getBlockHeader(local || 0, (err, block) => {
                    if (err) {
                        // assume the error is block is not valid
                        resolve();
                    } else {
                        resolve(block);
                    }
                });
            });
        }).then(block => {
            if (!block) {
                // the latest local block does not on the chain, invalidate it
                return this.storage.invalidateLatestBlock().then(() => {
                    throw InvalidBlockError;
                });
            }

            if (!block.nextHash) {
                throw AlreadyLatestBlockError;
            }

            // get next block
            return new Promise((resolve, reject) => {
                this.node.getBlockOverview(block.nextHash, (err, block) => {
                    if (err) {
                        // assume the error is block is not valid
                        resolve();
                    } else {
                        resolve(block);
                    }
                });
            });
        }).then(block => {
            if (!block) {
                // the next block for latest local block does not on the chain, invalidate the latest local block
                return this.storage.invalidateLatestBlock().then(() => {
                    throw InvalidBlockError;
                });
            }

            // get a set of transactions that already have for the block
            // we need this due to previously there is a bug that allow one transaction to be duplicated
            return this.storage.hasTransactions(block.txids).then(skips => ({ block, skips }));
        }).then(({ block, skips }) => {
            // get all transactions for the block
            let promise = undefined;
            let txs = [];

            for (let id of block.txids) {
                // skill if it is duplicated
                if (skips.has(id)) {
                    continue;
                }

                // get transaction detail
                if (promise) {
                    promise = promise.then(tx => {
                        txs.push(tx);
                        return this.getTransaction(id);
                    });
                } else {
                    promise = this.getTransaction(id);
                }

                // it is possible for transaction to be duplicated in the same block
                skips.add(id);
            }

            // it is possible that all transactions in the block are duplicated
            if (!promise) {
                return { block, txs: [] };
            }

            return promise.then(tx => {
                txs.push(tx);
                return { block, txs };
            });
        }).then(({ block, txs }) => {
            // if one of txs is undefined that mean a chain has been switched while we requesting transaction details
            if (txs.some(tx => tx === undefined)) {
                return this.storage.invalidateLatestBlock().then(() => {
                    throw InvalidBlockError;
                });
            }

            return this.storage.addBlock(block, txs).then(() => block);
        }).then(block => {
            if (block.height % 100 === 0) {
                this.node.log.info('Blocks scanned:', block.height);
            }

            // start next loop
            this.startScanBlocks();
        }).catch(err => {
            if (err == InvalidBlockError) {
                // start next loop
                this.startScanBlocks();
            } else if (err == AlreadyLatestBlockError) {
                // local block is already up to date, wait until there is a new block to scan again
                this.node.log.info('All blocks has been scanned');

                if (this.state === Stopping) {
                    this.startScanBlocks();
                } else {
                    this.state = WaitingBlocks;
                    this.node.services.helpd.once('block', this.startScanBlocks);
                }

                this.emit('latestBlockScanned');
            } else {
                throw err;
            }
        });
    }

    getTransaction(txid) {
        return new Promise((resolve, reject) => {
            this.node.getDetailedTransaction(txid, (err, transaction) => {
                if (err) {
                    resolve();
                } else {
                    resolve(transaction);
                }
            });
        });
    };
}

module.exports = RichListController;
