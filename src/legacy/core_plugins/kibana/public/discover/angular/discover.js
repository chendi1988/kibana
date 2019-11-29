/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import _ from 'lodash';
import React from 'react';
import { Subscription } from 'rxjs';
import moment from 'moment';
import dateMath from '@elastic/datemath';
import { i18n } from '@kbn/i18n';
import '../saved_searches/saved_searches';
import '../components/field_chooser/field_chooser';

// doc table
import './doc_table';
import { getSort } from './doc_table/lib/get_sort';
import { getSortForSearchSource } from './doc_table/lib/get_sort_for_search_source';
import * as columnActions from './doc_table/actions/columns';

import indexTemplate from './discover.html';
import { showOpenSearchPanel } from '../top_nav/show_open_search_panel';
import { addHelpMenuToAppChrome } from '../components/help_menu/help_menu_util';
import '../components/fetch_error';
import { getPainlessError } from './get_painless_error';
import {
  angular,
  buildVislibDimensions,
  getRequestInspectorStats,
  getResponseInspectorStats,
  getServices,
  getUnhashableStatesProvider,
  hasSearchStategyForIndexPattern,
  intervalOptions,
  isDefaultTypeIndexPattern,
  migrateLegacyQuery,
  RequestAdapter,
  showSaveModal,
  unhashUrl,
  stateMonitorFactory,
  subscribeWithScope,
  tabifyAggResponse,
  vislibSeriesResponseHandlerProvider,
  Vis,
  SavedObjectSaveModal,
  ensureDefaultIndexPattern,
} from '../kibana_services';

const {
  core,
  chrome,
  docTitle,
  FilterBarQueryFilterProvider,
  share,
  StateProvider,
  timefilter,
  npData,
  toastNotifications,
  uiModules,
  uiRoutes,
}  = getServices();

import { getRootBreadcrumbs, getSavedSearchBreadcrumbs } from '../breadcrumbs';
import { generateFilters } from '../../../../../../plugins/data/public';
import { start as data } from '../../../../data/public/legacy';

const savedQueryService = npData.query.savedQueries;

const fetchStatuses = {
  UNINITIALIZED: 'uninitialized',
  LOADING: 'loading',
  COMPLETE: 'complete',
};

const app = uiModules.get('apps/discover', [
  'kibana/url',
  'kibana/index_patterns'
]);

uiRoutes
  .defaults(/^\/discover(\/|$)/, {
    requireUICapability: 'discover.show',
    k7Breadcrumbs: ($route, $injector) =>
      $injector.invoke(
        $route.current.params.id
          ? getSavedSearchBreadcrumbs
          : getRootBreadcrumbs
      ),
    badge: uiCapabilities => {
      if (uiCapabilities.discover.save) {
        return undefined;
      }

      return {
        text: i18n.translate('kbn.discover.badge.readOnly.text', {
          defaultMessage: 'Read only',
        }),
        tooltip: i18n.translate('kbn.discover.badge.readOnly.tooltip', {
          defaultMessage: 'Unable to save searches',
        }),
        iconType: 'glasses'
      };
    }
  })
  .when('/discover/:id?', {
    template: indexTemplate,
    reloadOnSearch: false,
    resolve: {
      savedObjects: function (Promise, indexPatterns, config, Private, $rootScope, kbnUrl, redirectWhenMissing, savedSearches, $route) {
        const State = Private(StateProvider);
        const savedSearchId = $route.current.params.id;

        return ensureDefaultIndexPattern(core, data, $rootScope, kbnUrl).then(() => {
          return Promise.props({
            ip: indexPatterns.getCache().then((savedObjects) => {
              /**
               *  In making the indexPattern modifiable it was placed in appState. Unfortunately,
               *  the load order of AppState conflicts with the load order of many other things
               *  so in order to get the name of the index we should use, and to switch to the
               *  default if necessary, we parse the appState with a temporary State object and
               *  then destroy it immediatly after we're done
               *
               *  @type {State}
               */
              const state = new State('_a', {});

              const specified = !!state.index;
              const exists = _.findIndex(savedObjects, o => o.id === state.index) > -1;
              const id = exists ? state.index : config.get('defaultIndex');
              state.destroy();

              return Promise.props({
                list: savedObjects,
                loaded: indexPatterns.get(id),
                stateVal: state.index,
                stateValFound: specified && exists
              });
            }),
            savedSearch: savedSearches.get(savedSearchId)
              .then((savedSearch) => {
                if (savedSearchId) {
                  chrome.recentlyAccessed.add(
                    savedSearch.getFullPath(),
                    savedSearch.title,
                    savedSearchId);
                }
                return savedSearch;
              })
              .catch(redirectWhenMissing({
                'search': '/discover',
                'index-pattern': '/management/kibana/objects/savedSearches/' + $route.current.params.id
              }))
          });
        });
      },
    }
  });

app.directive('discoverApp', function () {
  return {
    restrict: 'E',
    controllerAs: 'discoverApp',
    controller: discoverController
  };
});

function discoverController(
  $element,
  $route,
  $scope,
  $timeout,
  $window,
  AppState,
  Private,
  Promise,
  config,
  kbnUrl,
  localStorage,
  uiCapabilities
) {
  const responseHandler = vislibSeriesResponseHandlerProvider().handler;
  const getUnhashableStates = Private(getUnhashableStatesProvider);

  const queryFilter = Private(FilterBarQueryFilterProvider);

  const inspectorAdapters = {
    requests: new RequestAdapter()
  };

  const subscriptions = new Subscription();

  timefilter.disableTimeRangeSelector();
  timefilter.disableAutoRefreshSelector();
  $scope.timefilterUpdateHandler = (ranges) => {
    timefilter.setTime({
      from: moment(ranges.from).toISOString(),
      to: moment(ranges.to).toISOString(),
      mode: 'absolute',
    });
  };
  $scope.intervalOptions = intervalOptions;
  $scope.showInterval = false;
  $scope.minimumVisibleRows = 50;
  $scope.fetchStatus = fetchStatuses.UNINITIALIZED;
  $scope.refreshInterval = timefilter.getRefreshInterval();
  $scope.showSaveQuery = uiCapabilities.discover.saveQuery;

  $scope.$watch(() => uiCapabilities.discover.saveQuery, (newCapability) => {
    $scope.showSaveQuery = newCapability;
  });

  $scope.intervalEnabled = function (interval) {
    return interval.val !== 'custom';
  };

  // the saved savedSearch
  const savedSearch = $route.current.locals.savedObjects.savedSearch;

  let abortController;
  $scope.$on('$destroy', () => {
    if (abortController) abortController.abort();
    savedSearch.destroy();
    subscriptions.unsubscribe();
  });

  const $appStatus = $scope.appStatus = this.appStatus = {
    dirty: !savedSearch.id
  };

  const getTopNavLinks = () => {
    const newSearch = {
      id: 'new',
      label: i18n.translate('kbn.discover.localMenu.localMenu.newSearchTitle', {
        defaultMessage: 'New',
      }),
      description: i18n.translate('kbn.discover.localMenu.newSearchDescription', {
        defaultMessage: 'New Search',
      }),
      run: function () { $scope.$evalAsync(() => { kbnUrl.change('/discover'); }); },
      testId: 'discoverNewButton',
    };

    const saveSearch = {
      id: 'save',
      label: i18n.translate('kbn.discover.localMenu.saveTitle', {
        defaultMessage: 'Save',
      }),
      description: i18n.translate('kbn.discover.localMenu.saveSearchDescription', {
        defaultMessage: 'Save Search',
      }),
      testId: 'discoverSaveButton',
      run: async () => {
        const onSave = ({ newTitle, newCopyOnSave, isTitleDuplicateConfirmed, onTitleDuplicate }) => {
          const currentTitle = savedSearch.title;
          savedSearch.title = newTitle;
          savedSearch.copyOnSave = newCopyOnSave;
          const saveOptions = {
            confirmOverwrite: false,
            isTitleDuplicateConfirmed,
            onTitleDuplicate,
          };
          return saveDataSource(saveOptions).then((response) => {
            // If the save wasn't successful, put the original values back.
            if (!response.id || response.error) {
              savedSearch.title = currentTitle;
            }
            return response;
          });
        };

        const saveModal = (
          <SavedObjectSaveModal
            onSave={onSave}
            onClose={() => { }}
            title={savedSearch.title}
            showCopyOnSave={savedSearch.id ? true : false}
            objectType="search"
            description={i18n.translate('kbn.discover.localMenu.saveSaveSearchDescription', {
              defaultMessage: 'Save your Discover search so you can use it in visualizations and dashboards',
            })}
          />);
        showSaveModal(saveModal);
      }
    };

    const openSearch = {
      id: 'open',
      label: i18n.translate('kbn.discover.localMenu.openTitle', {
        defaultMessage: 'Open',
      }),
      description: i18n.translate('kbn.discover.localMenu.openSavedSearchDescription', {
        defaultMessage: 'Open Saved Search',
      }),
      testId: 'discoverOpenButton',
      run: () => {
        showOpenSearchPanel({
          makeUrl: (searchId) => {
            return kbnUrl.eval('#/discover/{{id}}', { id: searchId });
          }
        });
      }
    };

    const shareSearch = {
      id: 'share',
      label: i18n.translate('kbn.discover.localMenu.shareTitle', {
        defaultMessage: 'Share',
      }),
      description: i18n.translate('kbn.discover.localMenu.shareSearchDescription', {
        defaultMessage: 'Share Search',
      }),
      testId: 'shareTopNavButton',
      run: async (anchorElement) => {
        const sharingData = await this.getSharingData();
        share.toggleShareContextMenu({
          anchorElement,
          allowEmbed: false,
          allowShortUrl: uiCapabilities.discover.createShortUrl,
          shareableUrl: unhashUrl(window.location.href, getUnhashableStates()),
          objectId: savedSearch.id,
          objectType: 'search',
          sharingData: {
            ...sharingData,
            title: savedSearch.title,
          },
          isDirty: $appStatus.dirty,
        });
      }
    };

    const inspectSearch = {
      id: 'inspect',
      label: i18n.translate('kbn.discover.localMenu.inspectTitle', {
        defaultMessage: 'Inspect',
      }),
      description: i18n.translate('kbn.discover.localMenu.openInspectorForSearchDescription', {
        defaultMessage: 'Open Inspector for search',
      }),
      testId: 'openInspectorButton',
      run() {
        getServices().inspector.open(inspectorAdapters, {
          title: savedSearch.title
        });
      }
    };

    return [
      newSearch,
      ...(uiCapabilities.discover.save ? [saveSearch] : []),
      openSearch,
      shareSearch,
      inspectSearch,
    ];
  };

  $scope.topNavMenu = getTopNavLinks();

  // the actual courier.SearchSource
  $scope.searchSource = savedSearch.searchSource;
  $scope.indexPattern = resolveIndexPatternLoading();

  $scope.searchSource
    .setField('index', $scope.indexPattern)
    .setField('highlightAll', true)
    .setField('version', true);

  // Even when searching rollups, we want to use the default strategy so that we get back a
  // document-like response.
  $scope.searchSource.setPreferredSearchStrategyId('default');

  // searchSource which applies time range
  const timeRangeSearchSource = savedSearch.searchSource.create();
  if (isDefaultTypeIndexPattern($scope.indexPattern)) {
    timeRangeSearchSource.setField('filter', () => {
      return timefilter.createFilter($scope.indexPattern);
    });
  }

  $scope.searchSource.setParent(timeRangeSearchSource);

  const pageTitleSuffix = savedSearch.id && savedSearch.title ? `: ${savedSearch.title}` : '';
  docTitle.change(`Discover${pageTitleSuffix}`);
  const discoverBreadcrumbsTitle = i18n.translate('kbn.discover.discoverBreadcrumbTitle', {
    defaultMessage: 'Discover',
  });

  if (savedSearch.id && savedSearch.title) {
    chrome.setBreadcrumbs([{
      text: discoverBreadcrumbsTitle,
      href: '#/discover',
    }, { text: savedSearch.title }]);
  } else {
    chrome.setBreadcrumbs([{
      text: discoverBreadcrumbsTitle,
    }]);
  }

  let stateMonitor;

  const $state = $scope.state = new AppState(getStateDefaults());

  $scope.filters = queryFilter.getFilters();
  $scope.screenTitle = savedSearch.title;

  $scope.onFiltersUpdated = filters => {
    // The filters will automatically be set when the queryFilter emits an update event (see below)
    queryFilter.setFilters(filters);
  };

  const getFieldCounts = async () => {
    // the field counts aren't set until we have the data back,
    // so we wait for the fetch to be done before proceeding
    if ($scope.fetchStatus === fetchStatuses.COMPLETE) {
      return $scope.fieldCounts;
    }

    return await new Promise(resolve => {
      const unwatch = $scope.$watch('fetchStatus', (newValue) => {
        if (newValue === fetchStatuses.COMPLETE) {
          unwatch();
          resolve($scope.fieldCounts);
        }
      });
    });
  };

  const getSharingDataFields = async () => {
    const selectedFields = $state.columns;
    if (selectedFields.length === 1 && selectedFields[0] ===  '_source') {
      const fieldCounts = await getFieldCounts();
      return {
        searchFields: null,
        selectFields: _.keys(fieldCounts).sort()
      };
    }

    const timeFieldName = $scope.indexPattern.timeFieldName;
    const hideTimeColumn = config.get('doc_table:hideTimeColumn');
    const fields = (timeFieldName && !hideTimeColumn) ? [timeFieldName, ...selectedFields] : selectedFields;
    return {
      searchFields: fields,
      selectFields: fields
    };
  };

  this.getSharingData = async () => {
    const searchSource = $scope.searchSource.createCopy();

    const { searchFields, selectFields } = await getSharingDataFields();
    searchSource.setField('fields', searchFields);
    searchSource.setField('sort', getSortForSearchSource($state.sort, $scope.indexPattern));
    searchSource.setField('highlight', null);
    searchSource.setField('highlightAll', null);
    searchSource.setField('aggs', null);
    searchSource.setField('size', null);

    const body = await searchSource.getSearchRequestBody();
    return {
      searchRequest: {
        index: searchSource.getField('index').title,
        body
      },
      fields: selectFields,
      metaFields: $scope.indexPattern.metaFields,
      conflictedTypesFields: $scope.indexPattern.fields.filter(f => f.type === 'conflict').map(f => f.name),
      indexPatternId: searchSource.getField('index').id
    };
  };

  $scope.uiState = $state.makeStateful('uiState');

  function getStateDefaults() {
    return {
      query: ($scope.savedQuery && $scope.savedQuery.attributes.query)
        || $scope.searchSource.getField('query')
        || {
          query: '',
          language: localStorage.get('kibana.userQueryLanguage') || config.get('search:queryLanguage')
        },
      sort: getSort.array(savedSearch.sort, $scope.indexPattern, config.get('discover:sort:defaultOrder')),
      columns: savedSearch.columns.length > 0 ? savedSearch.columns : config.get('defaultColumns').slice(),
      index: $scope.indexPattern.id,
      interval: 'auto',
      filters: ($scope.savedQuery && $scope.savedQuery.attributes.filters)
        || _.cloneDeep($scope.searchSource.getOwnField('filter'))
    };
  }

  $state.index = $scope.indexPattern.id;
  $state.sort = getSort.array($state.sort, $scope.indexPattern);

  $scope.getBucketIntervalToolTipText = () => {
    return i18n.translate('kbn.discover.bucketIntervalTooltip', {
      // eslint-disable-next-line max-len
      defaultMessage: 'This interval creates {bucketsDescription} to show in the selected time range, so it has been scaled to {bucketIntervalDescription}',
      values: {
        bucketsDescription: $scope.bucketInterval.scale > 1
          ? i18n.translate('kbn.discover.bucketIntervalTooltip.tooLargeBucketsText', {
            defaultMessage: 'buckets that are too large',
          })
          : i18n.translate('kbn.discover.bucketIntervalTooltip.tooManyBucketsText', {
            defaultMessage: 'too many buckets',
          }),
        bucketIntervalDescription: $scope.bucketInterval.description,
      },
    });
  };

  $scope.$watchCollection('state.columns', function () {
    $state.save();
  });

  $scope.opts = {
    // number of records to fetch, then paginate through
    sampleSize: config.get('discover:sampleSize'),
    timefield: isDefaultTypeIndexPattern($scope.indexPattern) && $scope.indexPattern.timeFieldName,
    savedSearch: savedSearch,
    indexPatternList: $route.current.locals.savedObjects.ip.list,
  };

  const shouldSearchOnPageLoad = () => {
    // If a saved query is referenced in the app state, omit the initial load because the saved query will
    // be fetched separately and trigger a reload
    if ($scope.state.savedQuery) {
      return false;
    }
    // A saved search is created on every page load, so we check the ID to see if we're loading a
    // previously saved search or if it is just transient
    return config.get('discover:searchOnPageLoad')
      || savedSearch.id !== undefined
      || _.get($scope, 'refreshInterval.pause') === false;
  };

  const init = _.once(function () {
    stateMonitor = stateMonitorFactory.create($state, getStateDefaults());
    stateMonitor.onChange((status) => {
      $appStatus.dirty = status.dirty || !savedSearch.id;
    });
    $scope.$on('$destroy', () => stateMonitor.destroy());

    $scope.updateDataSource()
      .then(function () {
        subscriptions.add(subscribeWithScope($scope, timefilter.getAutoRefreshFetch$(), {
          next: $scope.fetch
        }));

        subscriptions.add(subscribeWithScope($scope, timefilter.getRefreshIntervalUpdate$(), {
          next: $scope.updateRefreshInterval
        }));
        subscriptions.add(subscribeWithScope($scope, timefilter.getTimeUpdate$(), {
          next: $scope.updateTime
        }));
        subscriptions.add(subscribeWithScope($scope, timefilter.getFetch$(), {
          next: $scope.fetch
        }));

        $scope.$watchCollection('state.sort', function (sort) {
          if (!sort) return;

          // get the current sort from searchSource as array of arrays
          const currentSort = getSort.array($scope.searchSource.getField('sort'), $scope.indexPattern);

          // if the searchSource doesn't know, tell it so
          if (!angular.equals(sort, currentSort)) $scope.fetch();
        });

        // update data source when filters update
        subscriptions.add(subscribeWithScope($scope, queryFilter.getUpdates$(), {
          next: () => {
            $scope.filters = queryFilter.getFilters();
            $scope.updateDataSource().then(function () {
              $state.save();
            });
          }
        }));

        // fetch data when filters fire fetch event
        subscriptions.add(subscribeWithScope($scope, queryFilter.getUpdates$(), {
          next: $scope.fetch
        }));

        // update data source when hitting forward/back and the query changes
        $scope.$listen($state, 'fetch_with_changes', function (diff) {
          if (diff.indexOf('query') >= 0) $scope.fetch();
        });

        $scope.$watch('opts.timefield', function (timefield) {
          $scope.enableTimeRangeSelector = !!timefield;
        });

        $scope.$watch('state.interval', function (newInterval, oldInterval) {
          if (newInterval !== oldInterval) {
            $scope.fetch();
          }
        });

        $scope.$watch('vis.aggs', function () {
        // no timefield, no vis, nothing to update
          if (!$scope.opts.timefield) return;

          const buckets = $scope.vis.getAggConfig().bySchemaGroup('buckets');

          if (buckets && buckets.length === 1) {
            $scope.bucketInterval = buckets[0].buckets.getInterval();
          }
        });

        $scope.$watch('state.query', (newQuery, oldQuery) => {
          if (!_.isEqual(newQuery, oldQuery)) {
            const query = migrateLegacyQuery(newQuery);
            $scope.updateQueryAndFetch({ query });
          }
        });

        $scope.$watchMulti([
          'rows',
          'fetchStatus'
        ], (function updateResultState() {
          let prev = {};
          const status = {
            UNINITIALIZED: 'uninitialized',
            LOADING: 'loading', // initial data load
            READY: 'ready', // results came back
            NO_RESULTS: 'none' // no results came back
          };

          function pick(rows, oldRows, fetchStatus) {
            // initial state, pretend we're already loading if we're about to execute a search so
            // that the uninitilized message doesn't flash on screen
            if (rows == null && oldRows == null && shouldSearchOnPageLoad()) {
              return status.LOADING;
            }

            if (fetchStatus === fetchStatuses.UNINITIALIZED) {
              return status.UNINITIALIZED;
            }

            const rowsEmpty = _.isEmpty(rows);
            if (rowsEmpty && fetchStatus === fetchStatuses.LOADING) return status.LOADING;
            else if (!rowsEmpty) return status.READY;
            else return status.NO_RESULTS;
          }

          return function () {
            const current = {
              rows: $scope.rows,
              fetchStatus: $scope.fetchStatus
            };

            $scope.resultState = pick(
              current.rows,
              prev.rows,
              current.fetchStatus,
              prev.fetchStatus
            );

            prev = current;
          };
        }()));

        if ($scope.opts.timefield) {
          setupVisualization();
          $scope.updateTime();
        }

        init.complete = true;
        $state.replace();

        if (shouldSearchOnPageLoad()) {
          $scope.fetch();
        }
      });
  });

  async function saveDataSource(saveOptions) {
    await $scope.updateDataSource();

    savedSearch.columns = $scope.state.columns;
    savedSearch.sort = $scope.state.sort;

    try {
      const id = await savedSearch.save(saveOptions);
      $scope.$evalAsync(() => {
        stateMonitor.setInitialState($state.toJSON());
        if (id) {
          toastNotifications.addSuccess({
            title: i18n.translate('kbn.discover.notifications.savedSearchTitle', {
              defaultMessage: `Search '{savedSearchTitle}' was saved`,
              values: {
                savedSearchTitle: savedSearch.title,
              }
            }),
            'data-test-subj': 'saveSearchSuccess',
          });

          if (savedSearch.id !== $route.current.params.id) {
            kbnUrl.change('/discover/{{id}}', { id: savedSearch.id });
          } else {
            // Update defaults so that "reload saved query" functions correctly
            $state.setDefaults(getStateDefaults());
            docTitle.change(savedSearch.lastSavedTitle);
          }
        }
      });
      return { id };
    } catch(saveError) {
      toastNotifications.addDanger({
        title: i18n.translate('kbn.discover.notifications.notSavedSearchTitle', {
          defaultMessage: `Search '{savedSearchTitle}' was not saved.`,
          values: {
            savedSearchTitle: savedSearch.title,
          }
        }),
        text: saveError.message
      });
      return { error: saveError };
    }
  }

  $scope.opts.fetch = $scope.fetch = function () {
    // ignore requests to fetch before the app inits
    if (!init.complete) return;

    $scope.fetchError = undefined;

    $scope.updateTime();

    // Abort any in-progress requests before fetching again
    if (abortController) abortController.abort();
    abortController = new AbortController();

    $scope.updateDataSource()
      .then(setupVisualization)
      .then(function () {
        $state.save();
        $scope.fetchStatus = fetchStatuses.LOADING;
        logInspectorRequest();
        return $scope.searchSource.fetch({
          abortSignal: abortController.signal
        });
      })
      .then(onResults)
      .catch((error) => {
        // If the request was aborted then no need to surface this error in the UI
        if (error instanceof Error && error.name === 'AbortError') return;

        const fetchError = getPainlessError(error);

        if (fetchError) {
          $scope.fetchError = fetchError;
        } else {
          toastNotifications.addError(error, {
            title: i18n.translate('kbn.discover.errorLoadingData', {
              defaultMessage: 'Error loading data',
            }),
          });
        }
      });
  };

  $scope.updateQueryAndFetch = function ({ query, dateRange }) {
    timefilter.setTime(dateRange);
    $state.query = query;
    $scope.fetch();
  };

  function onResults(resp) {
    logInspectorResponse(resp);

    if ($scope.opts.timefield) {
      const tabifiedData = tabifyAggResponse($scope.vis.aggs, resp);
      $scope.searchSource.rawResponse = resp;
      Promise
        .resolve(buildVislibDimensions($scope.vis, { timeRange: $scope.timeRange, searchSource: $scope.searchSource }))
        .then(resp => responseHandler(tabifiedData, resp))
        .then(resp => {
          $scope.histogramData = resp;
        });
    }

    $scope.hits = resp.hits.total;
    $scope.rows = resp.hits.hits;

    // if we haven't counted yet, reset the counts
    const counts = $scope.fieldCounts = $scope.fieldCounts || {};

    $scope.rows.forEach(hit => {
      const fields = Object.keys($scope.indexPattern.flattenHit(hit));
      fields.forEach(fieldName => {
        counts[fieldName] = (counts[fieldName] || 0) + 1;
      });
    });

    $scope.fetchStatus = fetchStatuses.COMPLETE;
  }

  let inspectorRequest;

  function logInspectorRequest() {
    inspectorAdapters.requests.reset();
    const title = i18n.translate('kbn.discover.inspectorRequestDataTitle', {
      defaultMessage: 'Data',
    });
    const description = i18n.translate('kbn.discover.inspectorRequestDescription', {
      defaultMessage: 'This request queries Elasticsearch to fetch the data for the search.',
    });
    inspectorRequest = inspectorAdapters.requests.start(title, { description });
    inspectorRequest.stats(getRequestInspectorStats($scope.searchSource));
    $scope.searchSource.getSearchRequestBody().then(body => {
      inspectorRequest.json(body);
    });
  }

  function logInspectorResponse(resp) {
    inspectorRequest
      .stats(getResponseInspectorStats($scope.searchSource, resp))
      .ok({ json: resp });
  }

  $scope.updateTime = function () {
    $scope.timeRange = {
      from: dateMath.parse(timefilter.getTime().from),
      to: dateMath.parse(timefilter.getTime().to, { roundUp: true })
    };
    $scope.time = timefilter.getTime();
  };

  $scope.toMoment = function (datetime) {
    return moment(datetime).format(config.get('dateFormat'));
  };

  $scope.updateRefreshInterval = function () {
    const newInterval = timefilter.getRefreshInterval();
    const shouldFetch = _.get($scope, 'refreshInterval.pause') === true && newInterval.pause === false;

    $scope.refreshInterval = newInterval;

    if (shouldFetch) {
      $scope.fetch();
    }
  };

  $scope.onRefreshChange = function ({ isPaused, refreshInterval }) {
    timefilter.setRefreshInterval({
      pause: isPaused,
      value: refreshInterval ? refreshInterval : $scope.refreshInterval.value
    });
  };

  $scope.resetQuery = function () {
    kbnUrl.change('/discover/{{id}}', { id: $route.current.params.id });
  };

  $scope.newQuery = function () {
    kbnUrl.change('/discover');
  };

  $scope.updateDataSource = Promise.method(function updateDataSource() {
    const { indexPattern, searchSource } = $scope;
    searchSource
      .setField('size', $scope.opts.sampleSize)
      .setField('sort', getSortForSearchSource($state.sort, indexPattern))
      .setField('query', !$state.query ? null : $state.query)
      .setField('filter', queryFilter.getFilters());
  });

  $scope.setSortOrder = function setSortOrder(sortPair) {
    $scope.state.sort = sortPair;
  };

  // TODO: On array fields, negating does not negate the combination, rather all terms
  $scope.filterQuery = function (field, values, operation) {
    $scope.indexPattern.popularizeField(field, 1);
    const newFilters = generateFilters(queryFilter, field, values, operation, $scope.indexPattern.id);
    return queryFilter.addFilters(newFilters);
  };

  $scope.addColumn = function addColumn(columnName) {
    $scope.indexPattern.popularizeField(columnName, 1);
    columnActions.addColumn($scope.state.columns, columnName);
  };

  $scope.removeColumn = function removeColumn(columnName) {
    $scope.indexPattern.popularizeField(columnName, 1);
    columnActions.removeColumn($scope.state.columns, columnName);
  };

  $scope.moveColumn = function moveColumn(columnName, newIndex) {
    columnActions.moveColumn($scope.state.columns, columnName, newIndex);
  };

  $scope.scrollToTop = function () {
    $window.scrollTo(0, 0);
  };

  $scope.scrollToBottom = function () {
    // delay scrolling to after the rows have been rendered
    $timeout(() => {
      $element.find('#discoverBottomMarker').focus();
    }, 0);
  };

  $scope.showAllRows = function () {
    $scope.minimumVisibleRows = $scope.hits;
  };

  $scope.onQuerySaved = savedQuery => {
    $scope.savedQuery = savedQuery;
  };

  $scope.onSavedQueryUpdated = savedQuery => {
    $scope.savedQuery = { ...savedQuery };
  };

  $scope.onClearSavedQuery = () => {
    delete $scope.savedQuery;
    delete $state.savedQuery;
    $state.query = {
      query: '',
      language: localStorage.get('kibana.userQueryLanguage') || config.get('search:queryLanguage'),
    };
    queryFilter.removeAll();
    $state.save();
    $scope.fetch();
  };

  const updateStateFromSavedQuery = (savedQuery) => {
    $state.query = savedQuery.attributes.query;
    $state.save();

    queryFilter.setFilters(savedQuery.attributes.filters || []);

    if (savedQuery.attributes.timefilter) {
      timefilter.setTime({
        from: savedQuery.attributes.timefilter.from,
        to: savedQuery.attributes.timefilter.to,
      });
      if (savedQuery.attributes.timefilter.refreshInterval) {
        timefilter.setRefreshInterval(savedQuery.attributes.timefilter.refreshInterval);
      }
    }

    $scope.fetch();
  };

  $scope.$watch('savedQuery', (newSavedQuery) => {
    if (!newSavedQuery) return;

    $state.savedQuery = newSavedQuery.id;
    $state.save();

    updateStateFromSavedQuery(newSavedQuery);

  });

  $scope.$watch('state.savedQuery', newSavedQueryId => {
    if (!newSavedQueryId) {
      $scope.savedQuery = undefined;
      return;
    }

    if (!$scope.savedQuery || newSavedQueryId !== $scope.savedQuery.id) {
      savedQueryService.getSavedQuery(newSavedQueryId).then((savedQuery) => {
        $scope.$evalAsync(() => {
          $scope.savedQuery = savedQuery;
          updateStateFromSavedQuery(savedQuery);
        });
      });
    }
  });

  async function setupVisualization() {
    // If no timefield has been specified we don't create a histogram of messages
    if (!$scope.opts.timefield) return;

    const visStateAggs = [
      {
        type: 'count',
        schema: 'metric'
      },
      {
        type: 'date_histogram',
        schema: 'segment',
        params: {
          field: $scope.opts.timefield,
          interval: $state.interval,
          timeRange: timefilter.getTime(),
        }
      }
    ];

    if ($scope.vis) {
      const visState = $scope.vis.getEnabledState();
      visState.aggs = visStateAggs;

      $scope.vis.setState(visState);
      return;
    }


    const visSavedObject = {
      indexPattern: $scope.indexPattern.id,
      visState: {
        type: 'histogram',
        title: savedSearch.title,
        params: {
          addLegend: false,
          addTimeMarker: true
        },
        aggs: visStateAggs
      }
    };

    $scope.vis = new Vis(
      $scope.searchSource.getField('index'),
      visSavedObject.visState
    );
    visSavedObject.vis = $scope.vis;

    $scope.searchSource.onRequestStart((searchSource, options) => {
      return $scope.vis.getAggConfig().onSearchRequestStart(searchSource, options);
    });

    $scope.searchSource.setField('aggs', function () {
      return $scope.vis.getAggConfig().toDsl();
    });
  }

  function resolveIndexPatternLoading() {
    const {
      loaded: loadedIndexPattern,
      stateVal,
      stateValFound,
    } = $route.current.locals.savedObjects.ip;

    const ownIndexPattern = $scope.searchSource.getOwnField('index');

    if (ownIndexPattern && !stateVal) {
      return ownIndexPattern;
    }

    if (stateVal && !stateValFound) {
      const warningTitle = i18n.translate('kbn.discover.valueIsNotConfiguredIndexPatternIDWarningTitle', {
        defaultMessage: '{stateVal} is not a configured index pattern ID',
        values: {
          stateVal: `"${stateVal}"`,
        },
      });

      if (ownIndexPattern) {
        toastNotifications.addWarning({
          title: warningTitle,
          text: i18n.translate('kbn.discover.showingSavedIndexPatternWarningDescription', {
            defaultMessage: 'Showing the saved index pattern: "{ownIndexPatternTitle}" ({ownIndexPatternId})',
            values: {
              ownIndexPatternTitle: ownIndexPattern.title,
              ownIndexPatternId: ownIndexPattern.id,
            },
          }),
        });
        return ownIndexPattern;
      }

      toastNotifications.addWarning({
        title: warningTitle,
        text: i18n.translate('kbn.discover.showingDefaultIndexPatternWarningDescription', {
          defaultMessage: 'Showing the default index pattern: "{loadedIndexPatternTitle}" ({loadedIndexPatternId})',
          values: {
            loadedIndexPatternTitle: loadedIndexPattern.title,
            loadedIndexPatternId: loadedIndexPattern.id,
          },
        }),
      });
    }

    return loadedIndexPattern;
  }

  // Block the UI from loading if the user has loaded a rollup index pattern but it isn't
  // supported.
  $scope.isUnsupportedIndexPattern = (
    !isDefaultTypeIndexPattern($route.current.locals.savedObjects.ip.loaded)
    && !hasSearchStategyForIndexPattern($route.current.locals.savedObjects.ip.loaded)
  );

  if ($scope.isUnsupportedIndexPattern) {
    $scope.unsupportedIndexPatternType = $route.current.locals.savedObjects.ip.loaded.type;
    return;
  }

  addHelpMenuToAppChrome(chrome);

  init();
}