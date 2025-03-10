import type { ErrorId } from "gatsby-cli/lib/structured-errors/error-map"
import { getNode } from "./../datastore"
import { IGatsbyPage, INodeManifest } from "./../redux/types"
import reporter from "gatsby-cli/lib/reporter"
import { store } from "../redux/"
import { internalActions } from "../redux/actions"
import path from "path"
import fs from "fs-extra"
import fastq from "fastq"

interface INodeManifestPage {
  path?: string
}

/**
 * This it the output after processing calls to the public unstable_createNodeManifest action
 */
interface INodeManifestOut {
  page: INodeManifestPage
  node: {
    id: string
  }
  foundPageBy: FoundPageBy
}

type FoundPageBy =
  | `ownerNodeId`
  | `filesystem-route-api`
  // for these three we warn to use ownerNodeId instead
  | `context.id`
  | `queryTracking`
  | `none`

/**
 * Finds a final built page by nodeId
 *
 * Note that this function wont work properly in `gatsby develop`
 * since develop no longer runs all page queries when creating pages.
 * We use the node id to query mapping to find the right page but
 * this mapping only exists once you've visited a page in your browser.
 * When this fn is being used for routing to previews the user wont necessarily have
 * visited the page in the browser yet.
 */
async function findPageOwnedByNodeId({ nodeId }: { nodeId: string }): Promise<{
  page: INodeManifestPage
  foundPageBy: FoundPageBy
}> {
  const state = store.getState()
  const { pages, nodes } = state
  const { byNode } = state.queries

  // in development queries are run on demand so we wont have an accurate nodeId->pages map until those pages are visited in the browser. We want this mapping before the page is visited in the browser so we can route to the right page in the browser.
  // So in development we can just use the Map of all pages (pagePath -> pageNode)
  // but for builds (preview inc builds or regular builds) we will have a full map
  // of all nodeId's to pages they're queried on and we can use that instead since it
  // will be a much smaller list of pages, resulting in better performance for large sites
  const usingPagesMap: boolean = `development` === process.env.NODE_ENV

  const pagePathSetOrMap = usingPagesMap
    ? // this is a Map of page path to page node
      pages
    : // this is a Set of page paths
      byNode?.get(nodeId)

  // the default page path is the first page found in
  // node id to page query tracking

  let pagePath = byNode?.get(nodeId)?.values()?.next()?.value

  let foundPageBy: FoundPageBy = pagePath ? `queryTracking` : `none`

  if (pagePathSetOrMap) {
    let ownerPagePath: string | undefined
    let foundOwnerNodeId = false

    // for each page this nodeId is queried in
    for (const pathOrPageObject of pagePathSetOrMap.values()) {
      // if we haven't found a page with this nodeId
      // set as page.ownerNodeId then run this logic.
      // this condition is on foundOwnerNodeId instead of ownerPagePath
      // in case we find a page with the nodeId in page.context.id
      // and then later in the loop there's a page with this nodeId
      // set on page.ownerNodeId.
      // We always want to prefer ownerPagePath over context.id
      if (foundOwnerNodeId) {
        break
      }

      const path = (
        usingPagesMap
          ? // in development we're using a Map, so the value here is a page object
            (pathOrPageObject as IGatsbyPage).path
          : // in builds we're using a Set so the page path is the value
            pathOrPageObject
      ) as string

      const fullPage: IGatsbyPage | undefined = pages.get(path)

      foundOwnerNodeId = fullPage?.ownerNodeId === nodeId

      const foundPageIdInContext = fullPage?.context.id === nodeId

      if (foundOwnerNodeId) {
        foundPageBy = `ownerNodeId`
      } else if (foundPageIdInContext && fullPage) {
        const pageCreatedByPluginName = nodes.get(
          fullPage.pluginCreatorId
        )?.name

        const pageCreatedByFilesystemPlugin =
          pageCreatedByPluginName === `gatsby-plugin-page-creator`

        foundPageBy = pageCreatedByFilesystemPlugin
          ? `filesystem-route-api`
          : `context.id`
      }

      if (
        fullPage &&
        // first check for the ownerNodeId on the page. this is
        // the defacto owner. Can't get more specific than this
        (foundOwnerNodeId ||
          // if there's no specified owner look to see if
          // pageContext has an `id` variable which matches our
          // nodeId. Using an "id" as a variable in queries is common
          // and if we don't have an owner this is a better guess
          // of an owner than grabbing the first page query we find
          // that's mapped to this node id.
          // this also makes this work with the filesystem Route API without
          // changing that API.
          foundPageIdInContext)
      ) {
        // save this path to use in our manifest!
        ownerPagePath = fullPage.path
      }
    }

    if (ownerPagePath) {
      pagePath = ownerPagePath
    }
  }

  return {
    page: {
      path: pagePath || null,
    },
    foundPageBy,
  }
}

// these id's correspond to error id's in
// packages/gatsby-cli/src/structured-errors/error-map.ts
export const foundPageByToLogIds = {
  none: `11801`,
  [`context.id`]: `11802`,
  queryTracking: `11803`,
  [`filesystem-route-api`]: `success`,
  ownerNodeId: `success`,
}

/**
 * Takes in some info about a node manifest and the page we did or didn't find for it, then warns and returns the warning string
 */
export function warnAboutNodeManifestMappingProblems({
  inputManifest,
  pagePath,
  foundPageBy,
  verbose,
}: {
  inputManifest: INodeManifest
  pagePath?: string
  foundPageBy: FoundPageBy
  verbose: boolean
}): { logId: string } {
  let logId: ErrorId | `success`

  switch (foundPageBy) {
    case `none`:
    case `context.id`:
    case `queryTracking`: {
      logId = foundPageByToLogIds[foundPageBy]
      if (verbose) {
        reporter.error({
          id: logId,
          context: {
            inputManifest,
            pagePath,
          },
        })
      }
      break
    }

    case `filesystem-route-api`:
    case `ownerNodeId`:
      logId = `success`
      break

    default: {
      throw Error(`Node Manifest mapping is in an impossible state`)
    }
  }

  return {
    logId,
  }
}

/**
 * Prepares and then writes out an individual node manifest file to be used for routing to previews. Manifest files are added via the public unstable_createNodeManifest action
 */
export async function processNodeManifest(
  inputManifest: INodeManifest,
  listOfUniqueErrorIds: Set<string>,
  nodeManifestPagePathMap: Map<string, string>,
  verboseLogs: boolean
): Promise<null | INodeManifestOut> {
  const nodeId = inputManifest.node.id
  const fullNode = getNode(nodeId)
  const noNodeWarningId = `11804`

  if (!fullNode) {
    if (verboseLogs) {
      reporter.error({
        id: noNodeWarningId,
        context: {
          pluginName: inputManifest.pluginName,
          nodeId,
        },
      })
    } else {
      listOfUniqueErrorIds.add(noNodeWarningId)
    }

    return null
  }

  // map the node to a page that was created
  const { page: nodeManifestPage, foundPageBy } = await findPageOwnedByNodeId({
    nodeId,
  })

  const nodeManifestMappingProblemsContext = {
    inputManifest,
    pagePath: nodeManifestPage.path,
    foundPageBy,
    verbose: verboseLogs,
  }

  if (verboseLogs) {
    warnAboutNodeManifestMappingProblems(nodeManifestMappingProblemsContext)
  } else {
    const { logId } = warnAboutNodeManifestMappingProblems(
      nodeManifestMappingProblemsContext
    )

    if (logId !== `success`) {
      listOfUniqueErrorIds.add(logId)
    }
  }

  const finalManifest: INodeManifestOut = {
    node: inputManifest.node,
    page: nodeManifestPage,
    foundPageBy,
  }

  const gatsbySiteDirectory = store.getState().program.directory

  let fileNameBase = inputManifest.manifestId

  /**
   * Windows has a handful of special/reserved characters that are not valid in a file path
   * @reference https://superuser.com/questions/358855/what-characters-are-safe-in-cross-platform-file-names-for-linux-windows-and-os
   *
   * The two exceptions to the list linked above are
   * - the colon that is part of the hard disk partition name at the beginning of a file path (i.e. C:)
   * - backslashes. We don't want to replace backslashes because those are used to delineate what the actual file path is
   *
   * During local development, node manifests can be written to disk but are generally unused as they are only used
   * for Content Sync which runs in Gatsby Cloud. Gatsby cloud is a Linux environment in which these special chars are valid in
   * filepaths. To avoid errors on Windows, we replace all instances of the special chars in the filepath (with the exception of the
   * hard disk partition name) with "-" to ensure that local Windows development setups do not break when attempting
   * to write one of these manifests to disk.
   */
  if (process.platform === `win32`) {
    fileNameBase = fileNameBase.replace(/:|\/|\*|\?|"|<|>|\||\\/g, `-`)
  }

  // write out the manifest file
  const manifestFilePath = path.join(
    gatsbySiteDirectory,
    `public`,
    `__node-manifests`,
    inputManifest.pluginName,
    `${fileNameBase}.json`
  )

  const manifestFileDir = path.dirname(manifestFilePath)

  await fs.ensureDir(manifestFileDir)
  await fs.writeJSON(manifestFilePath, finalManifest)

  if (verboseLogs) {
    reporter.info(
      `Plugin ${inputManifest.pluginName} created a manifest with the id ${fileNameBase}`
    )
  }

  if (nodeManifestPage.path) {
    nodeManifestPagePathMap.set(nodeManifestPage.path, fileNameBase)
  }

  return finalManifest
}

/**
 * Grabs all pending node manifests, processes them, writes them to disk,
 * and then removes them from the store.
 * Manifest files are added via the public unstable_createNodeManifest action in sourceNodes
 */
export async function processNodeManifests(): Promise<Map<
  string,
  string
> | null> {
  const verboseLogs =
    process.env.gatsby_log_level === `verbose` ||
    process.env.VERBOSE_NODE_MANIFEST === `true`

  const startTime = Date.now()
  const { nodeManifests } = store.getState()

  const totalManifests = nodeManifests.length

  if (totalManifests === 0) {
    return null
  }

  let totalProcessedManifests = 0
  let totalFailedManifests = 0
  const nodeManifestPagePathMap: Map<string, string> = new Map()
  const listOfUniqueErrorIds: Set<string> = new Set()

  async function processNodeManifestTask(
    manifest: INodeManifest,
    cb: fastq.done<any>
  ): Promise<void> {
    const processedManifest = await processNodeManifest(
      manifest,
      listOfUniqueErrorIds,
      nodeManifestPagePathMap,
      verboseLogs
    )

    if (processedManifest) {
      totalProcessedManifests++
    } else {
      totalFailedManifests++
    }

    // `setImmediate` below is a workaround against stack overflow
    // occurring when there are many manifests
    setImmediate(() => cb(null, true))
    return
  }

  const processNodeManifestQueue = fastq(processNodeManifestTask, 25)

  for (const manifest of nodeManifests) {
    processNodeManifestQueue.push(manifest, () => {})
  }

  if (!processNodeManifestQueue.idle()) {
    await new Promise(resolve => {
      processNodeManifestQueue.drain = resolve as () => unknown
    })
  }

  const pluralize = (length: number): string =>
    length > 1 || length === 0 ? `s` : ``

  const endTime = Date.now()

  reporter.info(
    `Wrote out ${totalProcessedManifests} node page manifest file${pluralize(
      totalProcessedManifests
    )} in ${endTime - startTime} ms. ${
      totalFailedManifests > 0
        ? `. ${totalFailedManifests} manifest${pluralize(
            totalFailedManifests
          )} couldn't be processed.`
        : ``
    }`
  )

  reporter.info(
    (!verboseLogs && listOfUniqueErrorIds.size > 0
      ? `unstable_createNodeManifest produced warnings [${[
          ...listOfUniqueErrorIds,
        ].join(`, `)}]. `
      : ``) +
      `To see full warning messages set process.env.VERBOSE_NODE_MANIFEST to "true".\nVisit https://gatsby.dev/nodemanifest for more info on Node Manifests.`
  )

  // clean up all pending manifests from the store
  store.dispatch(internalActions.deleteNodeManifests())
  return nodeManifestPagePathMap
}
