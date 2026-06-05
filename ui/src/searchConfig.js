// Shared MiniSearch config — imported by BOTH the Node build script and the
// browser app, so the prebuilt index loads with the exact same options.
export const MS_OPTIONS = {
  idField: 'id',
  fields: ['text'],
  // docs are sentences (one per language) OR video metadata (title/description/
  // comment). store what we need to locate the hit.
  storeFields: ['videoId', 'idx', 'lang', 'kind', 'cidx'],
  searchOptions: {
    prefix: true,          // "play" finds "playing"
    // no fuzzy: it surfaced near-spellings ("grand" -> "grond/brand") that don't
    // contain the term and made highlighting look like the whole video matched
    combineWith: 'AND',
  },
}

export const MIN_QUERY = 2
