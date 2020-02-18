// @flow

import type {Asset, Bundle, BundleGraph, Symbol} from '@parcel/types';
import * as t from '@babel/types';
import template from '@babel/template';
import invariant from 'assert';
import {relativeBundlePath} from '@parcel/utils';
import {isEntry, isReferenced} from '../utils';

const IMPORT_TEMPLATE = template.expression('parcelRequire(ASSET_ID)');
const EXPORT_TEMPLATE = template(
  'parcelRequire.register(ASSET_ID, IDENTIFIER)',
);
const IMPORTSCRIPTS_TEMPLATE = template('importScripts(BUNDLE)');

export function generateBundleImports(
  from: Bundle,
  bundle: Bundle,
  assets: Set<Asset>,
  path: any,
) {
  if (from.env.isWorker()) {
    path.unshiftContainer('body', [
      IMPORTSCRIPTS_TEMPLATE({
        BUNDLE: t.stringLiteral(relativeBundlePath(from, bundle)),
      }),
    ]);
  }

  for (let asset of assets) {
    // var ${asset.meta.exportsIdentifier}; was inserted already, add RHS
    let [decl] = path.scope
      .getBinding(asset.meta.exportsIdentifier)
      .path.get('init')
      .replaceWith(IMPORT_TEMPLATE({ASSET_ID: t.stringLiteral(asset.id)}));
    path.scope.getBinding('parcelRequire').reference(decl.get('callee'));
  }
}

export function generateExternalImport() {
  throw new Error(
    'External modules are not supported when building for browser',
  );
}

export function generateExports(
  bundleGraph: BundleGraph,
  bundle: Bundle,
  referencedAssets: Set<Asset>,
  path: any,
) {
  let exported = new Set<Symbol>();

  for (let asset of referencedAssets) {
    let exportsId = asset.meta.exportsIdentifier;
    invariant(typeof exportsId === 'string');
    exported.add(exportsId);

    let [decl] = path.pushContainer('body', [
      EXPORT_TEMPLATE({
        ASSET_ID: t.stringLiteral(asset.id),
        IDENTIFIER: t.identifier(exportsId),
      }),
    ]);
    path.scope.getBinding(exportsId)?.reference(decl.get('expression.right'));
  }

  let entry = bundle.getMainEntry();
  if (
    entry &&
    (!isEntry(bundle, bundleGraph) || isReferenced(bundle, bundleGraph))
  ) {
    let exportsId = entry.meta.exportsIdentifier;
    invariant(typeof exportsId === 'string');
    exported.add(exportsId);

    let [decl] = path.pushContainer('body', [
      EXPORT_TEMPLATE({
        ASSET_ID: t.stringLiteral(entry.id),
        IDENTIFIER: t.identifier(exportsId),
      }),
    ]);
    path.scope.getBinding(exportsId)?.reference(decl.get('expression.right'));
  }

  return exported;
}
