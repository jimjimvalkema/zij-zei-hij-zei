// Shared MiniSearch config — imported by BOTH the Node build script and the
// browser app, so the prebuilt index loads with the exact same options.
export const MS_OPTIONS = {
  idField: 'id',
  fields: ['text'],
  // docs are sentences (one per language) OR video metadata (title/description/
  // comment). store what we need to locate the hit.
  storeFields: ['videoId', 'idx', 'lang', 'kind', 'cidx'],
  searchOptions: {
    prefix: true,          // search-as-you-type
    fuzzy: 0.2,            // light typo tolerance
    combineWith: 'AND',
  },
}

export const MIN_QUERY = 2
