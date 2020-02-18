// @flow strict-local
import type {Bundle, BundleGraph} from '@parcel/types';

import assert from 'assert';
import {Packager} from '@parcel/plugin';
import posthtml from 'posthtml';
import {replaceURLReferences, urlJoin} from '@parcel/utils';
import nullthrows from 'nullthrows';

// https://www.w3.org/TR/html5/dom.html#metadata-content-2
const metadataContent = new Set([
  'base',
  'link',
  'meta',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);

export default new Packager({
  async package({bundle, bundleGraph, getInlineBundleContents}) {
    let assets = [];
    bundle.traverseAssets(asset => {
      assets.push(asset);
    });

    assert.equal(assets.length, 1, 'HTML bundles must only contain one asset');

    let asset = assets[0];
    let code = await asset.getCode();

    // Insert references to sibling bundles. For example, a <script> tag in the original HTML
    // may import CSS files. This will result in a sibling bundle in the same bundle group as the
    // JS. This will be inserted as a <link> element into the HTML here.
    let bundleGroups = bundleGraph
      .getExternalDependencies(bundle)
      .map(dependency => bundleGraph.resolveExternalDependency(dependency))
      .filter(Boolean);
    let bundles = bundleGroups.reduce((p, bundleGroup) => {
      let bundles = bundleGraph
        .getBundlesInBundleGroup(bundleGroup)
        .filter(
          bundle =>
            !bundle
              .getEntryAssets()
              .some(asset => asset.id === bundleGroup.entryAssetId),
        );
      return p.concat(bundles);
    }, []);

    // Add bundles in the same bundle group that are not inline. For example, if two inline
    // bundles refer to the same library that is extracted into a shared bundle.
    bundles = bundles.concat(
      bundleGraph.getSiblingBundles(bundle).filter(b => !b.isInline),
    );

    let {html} = await posthtml([
      insertBundleReferences.bind(this, bundles),
      replaceInlineAssetContent.bind(
        this,
        bundleGraph,
        getInlineBundleContents,
      ),
    ]).process(code);

    return replaceURLReferences({
      bundle,
      bundleGraph,
      contents: html,
      relative: false,
    });
  },
});

async function getAssetContent(
  bundleGraph: BundleGraph,
  getInlineBundleContents,
  assetId,
) {
  let inlineBundle: ?Bundle;
  bundleGraph.traverseBundles((bundle, context, {stop}) => {
    let mainAsset = bundle.getMainEntry();
    if (mainAsset && mainAsset.uniqueKey === assetId) {
      inlineBundle = bundle;
      stop();
    }
  });

  if (inlineBundle) {
    const bundleResult = await getInlineBundleContents(
      inlineBundle,
      bundleGraph,
    );

    return {bundle: inlineBundle, contents: bundleResult.contents};
  }

  return null;
}

async function replaceInlineAssetContent(
  bundleGraph: BundleGraph,
  getInlineBundleContents,
  tree,
) {
  const inlineNodes = [];
  tree.walk(node => {
    if (node.attrs && node.attrs['data-parcel-key']) {
      inlineNodes.push(node);
    }
    return node;
  });

  for (let node of inlineNodes) {
    let newContent = await getAssetContent(
      bundleGraph,
      getInlineBundleContents,
      node.attrs['data-parcel-key'],
    );

    if (newContent != null) {
      let {contents, bundle} = newContent;
      node.content = contents;

      if (bundle.env.outputFormat === 'esmodule') {
        node.attrs.type = 'module';
      }

      // remove attr from output
      delete node.attrs['data-parcel-key'];
    }
  }

  return tree;
}

function insertBundleReferences(siblingBundles, tree) {
  const bundles = [];

  for (let bundle of siblingBundles) {
    if (bundle.type === 'css') {
      bundles.push({
        tag: 'link',
        attrs: {
          rel: 'stylesheet',
          href: urlJoin(
            nullthrows(bundle.target).publicUrl,
            nullthrows(bundle.name),
          ),
        },
      });
    } else if (bundle.type === 'js') {
      bundles.push({
        tag: 'script',
        attrs: {
          type: bundle.env.outputFormat === 'esmodule' ? 'module' : undefined,
          src: urlJoin(
            nullthrows(bundle.target).publicUrl,
            nullthrows(bundle.name),
          ),
        },
      });
    }
  }

  addBundlesToTree(bundles, tree);
}

function addBundlesToTree(bundles, tree) {
  const head = find(tree, 'head');
  if (head) {
    const content = head.content || (head.content = []);
    content.push(...bundles);
    return;
  }

  const html = find(tree, 'html');
  const content = html ? html.content || (html.content = []) : tree;
  const index = findBundleInsertIndex(content);

  content.splice(index, 0, ...bundles);
}

function find(tree, tag) {
  let res;
  tree.match({tag}, node => {
    res = node;
    return node;
  });

  return res;
}

function findBundleInsertIndex(content) {
  for (let index = 0; index < content.length; index++) {
    const node = content[index];
    if (node && node.tag && !metadataContent.has(node.tag)) {
      return index;
    }
  }

  return 0;
}
