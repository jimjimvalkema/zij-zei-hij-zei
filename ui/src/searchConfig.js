// Shared MiniSearch config — imported by BOTH the Node build script and the
// browser app, so the prebuilt index loads with the exact same options.
export const MS_OPTIONS = {
  idField: 'id',
  fields: ['text'],
  // stored so search results carry everything needed to render + build links
  storeFields: ['videoId', 'start', 'end', 'speaker', 'global', 'lang', 'text'],
  searchOptions: {
    prefix: true,          // search-as-you-type
    fuzzy: 0.2,            // light typo tolerance
    combineWith: 'AND',
  },
}

export const MIN_QUERY = 2
