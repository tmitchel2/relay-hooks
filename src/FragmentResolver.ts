import {
    getSelector,
    IEnvironment,
    Disposable,
    Snapshot,
    getFragment,
    Variables,
    getVariablesFromFragment,
    ConnectionConfig,
    SingularReaderSelector,
    GraphQLTaggedNode,
    Observable,
    Observer,
    createOperationDescriptor,
    getRequest,
    CacheConfig,
    Subscription,
    getDataIDsFromFragment,
} from 'relay-runtime';

export type ObserverOrCallback = Observer<void> | ((error: Error) => any);
import * as areEqual from 'fbjs/lib/areEqual';
import * as invariant from 'fbjs/lib/invariant';
import * as ReactRelayQueryFetcher from 'react-relay/lib/ReactRelayQueryFetcher';
import {
    isNetworkPolicy,
    isStorePolicy,
    getPaginationData,
    _getConnectionData,
    toObserver,
    getRootVariablesForSelector,
    getNewSelector,
} from './Utils';
import { RefetchOptions, PaginationData } from './RelayHooksType';

type SingularOrPluralSnapshot = Snapshot | Array<Snapshot>;

type SingularOrPluralSelectors = SingularReaderSelector | Array<SingularReaderSelector>;

function lookupFragment(environment, selector) {
    return selector.kind === 'PluralReaderSelector' ? selector.selectors.map((s) => environment.lookup(s)) : environment.lookup(selector);
}

function getFragmentResult(snapshot: SingularOrPluralSnapshot): any {
    if (Array.isArray(snapshot)) {
        return { snapshot, data: snapshot.map((s) => s.data) };
    }
    return { snapshot, data: snapshot.data };
}

type FragmentResult = {
    snapshot: SingularOrPluralSnapshot | null;
    data: any;
};

class FragmentResolver {
    _environment: IEnvironment;
    _fragment: any;
    _fragmentNode: any;
    _fragmentRef: any;
    _result: FragmentResult;
    _disposable: Disposable = { dispose: () => {} };
    _selector: SingularOrPluralSelectors;
    _forceUpdate: any;
    _isPlural: boolean;
    queryFetcher = new ReactRelayQueryFetcher();
    _refetchSubscription: Subscription;
    paginationData: PaginationData;
    _refetchVariables: Variables;
    _isARequestInFlight = false;

    constructor(forceUpdate) {
        this._forceUpdate = forceUpdate;
    }

    forceUpdate() {
        this._forceUpdate();
    }

    dispose() {
        this._disposable && this._disposable.dispose();
        this.queryFetcher && this.queryFetcher.dispose();
        this._refetchSubscription && this._refetchSubscription.unsubscribe();
        this._refetchSubscription = null;

        this._isARequestInFlight = false;
    }

    getFragmentVariables(fRef = this._fragmentRef): Variables {
        return getVariablesFromFragment(this._fragment, fRef);
    }

    changedFragmentRef(fragmentRef) {
        if (this._fragmentRef !== fragmentRef) {
            const prevIDs = getDataIDsFromFragment(this._fragment, this._fragmentRef);
            const nextIDs = getDataIDsFromFragment(this._fragment, fragmentRef);

            if (
                !areEqual(prevIDs, nextIDs) ||
                !areEqual(this.getFragmentVariables(fragmentRef), this.getFragmentVariables(this._fragmentRef))
            ) {
                return true;
            }
        }
        return false;
    }

    resolve(environment: IEnvironment, fragmentNode, fragmentRef) {
        if (this._fragmentNode !== fragmentNode) {
            this._fragment = getFragment(fragmentNode);
            this.paginationData = null;
        }
        if (this._environment !== environment || this._fragmentNode !== fragmentNode || this.changedFragmentRef(fragmentRef)) {
            this._environment = environment;
            this._fragmentNode = fragmentNode;
            this._fragmentRef = fragmentRef;
            this._result = null;
            this.dispose();
            if (this._fragmentRef == null) {
                this._result = { data: null, snapshot: null };
            }

            // If fragmentRef is plural, ensure that it is an array.
            // If it's empty, return the empty array direclty before doing any more work.
            this._isPlural =
            this._fragment.metadata && this._fragment.metadata.plural && this._fragment.metadata.plural === true;
            if (this._isPlural) {
                if (this._fragmentRef.length === 0) {
                    this._result = { data: [], snapshot: [] };
                }
            }

            if (!this._result) {
                this._selector = getSelector(this._fragment, this._fragmentRef);
                this.lookup();
            }
        }
    }

    lookup() {
        const snapshot = lookupFragment(this._environment, this._selector);

        // if (!isMissingData(snapshot)) { this for promises
        this._result = getFragmentResult(snapshot);
        this.subscribe();
    }

    getData() {
        return this._result ? this._result.data : null;
    }

    subscribe() {
        const environment = this._environment;
        const renderedSnapshot = this._result.snapshot;
        if (!renderedSnapshot) {
            this._disposable = { dispose: () => {} };
        }

        const dataSubscriptions = [];

        const { snapshot: currentSnapshot } = this._result;
        if (Array.isArray(renderedSnapshot)) {
            currentSnapshot.forEach((snapshot, idx) => {
                dataSubscriptions.push(
                    environment.subscribe(snapshot, (latestSnapshot) => {
                        this._result.snapshot[idx] = latestSnapshot;
                        this._result.data[idx] = latestSnapshot.data;
                        this.forceUpdate();
                    }),
                );
            });
        } else {
            dataSubscriptions.push(
                environment.subscribe(currentSnapshot, (latestSnapshot) => {
                    this._result = getFragmentResult(latestSnapshot);
                    this.forceUpdate();
                }),
            );
        }

        this._disposable = {
            dispose: () => {
                dataSubscriptions.map((s) => s.dispose());
            },
        };
    }

    changeVariables(variables, request) {
        if (this._selector.kind === 'PluralReaderSelector') {
            this._selector.selectors = this._selector.selectors.map((s) => getNewSelector(request, s, variables));
        } else {
            this._selector = getNewSelector(request, this._selector, variables);
        }
        this.lookup();
    }

    lookupInStore(environment: IEnvironment, operation, fetchPolicy): Snapshot {
        if (isStorePolicy(fetchPolicy) && environment.check(operation.root)) {
            this.queryFetcher._retainCachedOperation(environment, operation);
            return environment.lookup(operation.fragment, operation);
        }
        return null;
    }

    refetch = (
        taggedNode: GraphQLTaggedNode,
        refetchVariables: Variables | ((fragmentVariables: Variables) => Variables),
        renderVariables: Variables,
        observerOrCallback: ObserverOrCallback,
        options: RefetchOptions,
    ) => {
        //TODO Function
        const fragmentVariables = this.getFragmentVariables();
        const fetchVariables = typeof refetchVariables === 'function' ? refetchVariables(fragmentVariables) : refetchVariables;
        const newFragmentVariables = renderVariables ? { ...fetchVariables, ...renderVariables } : fetchVariables;

        const cacheConfig: CacheConfig = options ? { force: !!options.force } : undefined;
        if (cacheConfig != null && options && options.metadata != null) {
            cacheConfig.metadata = options.metadata;
        }

        const observer =
            typeof observerOrCallback === 'function'
                ? {
                      next: observerOrCallback,
                      error: observerOrCallback,
                  }
                : observerOrCallback || ({} as any);

        const query = getRequest(taggedNode);
        const operation = createOperationDescriptor(query, fetchVariables);

        // TODO: T26288752 find a better way
        /* eslint-disable lint/react-state-props-mutation */
        //this.state.localVariables = fetchVariables;
        /* eslint-enable lint/react-state-props-mutation */

        // Cancel any previously running refetch.
        this._refetchSubscription && this._refetchSubscription.unsubscribe();

        // Declare refetchSubscription before assigning it in .start(), since
        // synchronous completion may call callbacks .subscribe() returns.
        let refetchSubscription;

        const optionsFetch = options ? options : {};

        const { fetchPolicy = 'network-only' } = optionsFetch;

        const storeSnapshot = this.lookupInStore(this._environment, operation, fetchPolicy);
        if (storeSnapshot != null) {
            this.changeVariables(newFragmentVariables, operation.request.node);
            this.forceUpdate();
            const complete = async () => {
                observer.next && observer.next();
                observer.complete && observer.complete();
            };
            complete();
        }
        const isNetworky = isNetworkPolicy(fetchPolicy, storeSnapshot);
        if (!isNetworky) {
            return {
                dispose: () => {},
            };
        }
        if (isNetworky) {
            this.queryFetcher
                .execute({
                    environment: this._environment,
                    operation,
                    cacheConfig,
                    // TODO (T26430099): Cleanup old references
                    preservePreviousReferences: true,
                })
                .mergeMap((response) => {
                    this.changeVariables(newFragmentVariables, operation.node || operation.request.node);
                    return Observable.create((sink) => {
                        this.forceUpdate();
                        const complete = async () => {
                            sink.next();
                            sink.complete();
                        };
                        complete();
                    });
                })
                .finally(() => {
                    // Finalizing a refetch should only clear this._refetchSubscription
                    // if the finizing subscription is the most recent call.
                    if (this._refetchSubscription === refetchSubscription) {
                        this._refetchSubscription = null;
                    }
                })
                .subscribe({
                    ...observer,
                    start: (subscription) => {
                        this._refetchSubscription = refetchSubscription = subscription;
                        observer.start && observer.start(subscription);
                    },
                });

            return {
                dispose: () => {
                    refetchSubscription && refetchSubscription.unsubscribe();
                },
            };
        }
    };

    // pagination

    isLoading = (): boolean => {
        return !!this._refetchSubscription;
    };

    hasMore = (connectionConfig?: ConnectionConfig): boolean => {
        this.paginationData = getPaginationData(this.paginationData, this._fragment);
        const connectionData = _getConnectionData(this.paginationData, this.getData(), connectionConfig);
        return !!(connectionData && connectionData.hasMore && connectionData.cursor);
    };

    refetchConnection = (
        connectionConfig: ConnectionConfig,
        totalCount: number,
        observerOrCallback: ObserverOrCallback,
        refetchVariables: Variables,
    ): Disposable => {
        this.paginationData = getPaginationData(this.paginationData, this._fragment);

        this._refetchVariables = refetchVariables;
        const paginatingVariables = {
            count: totalCount,
            cursor: null,
            totalCount,
        };
        const fetch = this._fetchPage(connectionConfig, paginatingVariables, toObserver(observerOrCallback), { force: true });

        return { dispose: fetch.unsubscribe };
    };

    loadMore = (connectionConfig: ConnectionConfig, pageSize: number, observerOrCallback: ObserverOrCallback, options: RefetchOptions) => {
        this.paginationData = getPaginationData(this.paginationData, this._fragment);

        const observer = toObserver(observerOrCallback);
        const connectionData = _getConnectionData(this.paginationData, this.getData(), connectionConfig);

        if (!connectionData) {
            Observable.create((sink) => sink.complete()).subscribe(observer);
            return null;
        }
        const totalCount = connectionData.edgeCount + pageSize;
        if (options && options.force) {
            return this.refetchConnection(connectionConfig, totalCount, observerOrCallback, undefined);
        }
        //const { END_CURSOR, START_CURSOR } = ConnectionInterface.get();
        const cursor = connectionData.cursor;
        /*warning(
            cursor,
            'ReactRelayPaginationContainer: Cannot `loadMore` without valid `%s` (got `%s`)',
            this._direction === FORWARD ? END_CURSOR : START_CURSOR,
            cursor,
        );*/
        const paginatingVariables = {
            count: pageSize,
            cursor: cursor,
            totalCount,
        };
        const fetch = this._fetchPage(connectionConfig, paginatingVariables, observer, options);
        return { dispose: fetch.unsubscribe };
    };

    _fetchPage(
        connectionConfig: ConnectionConfig,
        paginatingVariables: {
            count: number;
            cursor: string;
            totalCount: number;
        },
        observer: Observer<void>,
        options: RefetchOptions,
    ): Subscription {
        //const { componentRef: _, __relayContext, ...restProps } = this.props;
        //const resolver = prevResult.resolver;
        //const fragments = prevResult.resolver._fragments;
        const rootVariables = getRootVariablesForSelector(this._selector);
        // hack 6.0.0
        let fragmentVariables = {
            ...rootVariables,
            ...this.getFragmentVariables(),
            ...this._refetchVariables,
        };
        let fetchVariables = connectionConfig.getVariables(
            this.getData(),
            {
                count: paginatingVariables.count,
                cursor: paginatingVariables.cursor,
            },
            fragmentVariables,
        );
        invariant(
            typeof fetchVariables === 'object' && fetchVariables !== null,
            'ReactRelayPaginationContainer: Expected `getVariables()` to ' + 'return an object, got `%s` in `%s`.',
            fetchVariables,
            'useFragment pagination',
        );
        fetchVariables = {
            ...fetchVariables,
            ...this._refetchVariables,
        };
        fragmentVariables = {
            ...fetchVariables,
            ...fragmentVariables,
        };

        const cacheConfig: CacheConfig = options ? { force: !!options.force } : undefined;
        if (cacheConfig != null && options && options.metadata != null) {
            cacheConfig.metadata = options.metadata;
        }
        const request = getRequest(connectionConfig.query);
        const operation = createOperationDescriptor(request, fetchVariables);

        let refetchSubscription = null;

        if (this._refetchSubscription) {
            this._refetchSubscription.unsubscribe();
        }

        const onNext = (payload, complete) => {
            const prevData = this.getData();

            const getFragmentVariables = connectionConfig.getFragmentVariables || this.paginationData.getFragmentVariables;
            this.changeVariables(getFragmentVariables(fragmentVariables, paginatingVariables.totalCount), operation.request.node);

            const nextData = this.getData();

            // Workaround slightly different handling for connection in different
            // core implementations:
            // - Classic core requires the count to be explicitly incremented
            // - Modern core automatically appends new items, updating the count
            //   isn't required to see new data.
            //
            // `setState` is only required if changing the variables would change the
            // resolved data.
            // TODO #14894725: remove PaginationContainer equal check

            if (!areEqual(prevData, nextData)) {
                this.forceUpdate();
                const callComplete = async () => {
                    complete();
                };
                callComplete();
            } else {
                complete();
            }
        };

        const cleanup = () => {
            if (this._refetchSubscription === refetchSubscription) {
                this._refetchSubscription = null;
                this._isARequestInFlight = false;
            }
        };

        this._isARequestInFlight = true;
        refetchSubscription = this.queryFetcher
            .execute({
                environment: this._environment,
                operation,
                cacheConfig,
                preservePreviousReferences: true,
            })
            .mergeMap((payload) =>
                Observable.create((sink) => {
                    onNext(payload, () => {
                        sink.next(); // pass void to public observer's `next`
                        sink.complete();
                    });
                }),
            )
            // use do instead of finally so that observer's `complete` fires after cleanup
            .do({
                error: cleanup,
                complete: cleanup,
                unsubscribe: cleanup,
            })
            .subscribe(observer || {});

        this._refetchSubscription = this._isARequestInFlight ? refetchSubscription : null;

        return refetchSubscription;
    }
}

export default FragmentResolver;