/**
 * Code for generating config used by individual packages' Rollup configs
 */

import assert from 'assert';

import deepMerge from 'deepmerge';
import license from 'rollup-plugin-license';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import { terser } from 'rollup-plugin-terser';
import typescript from 'rollup-plugin-typescript2';

/**
 * Helper functions to compensate for the fact that JS can't handle negative array indices very well
 *
 * TODO `insertAt` is only exported so the integrations config can inject the `commonjs` plugin, for localforage (used
 * in the offline plugin). Once that's fixed to no longer be necessary, this can stop being exported.
 */
function getLastElement(array) {
  return array[array.length - 1];
}
export function insertAt(arr, index, insertee) {
  const newArr = [...arr];
  // Add 1 to the array length so that the inserted element ends up in the right spot with respect to the length of the
  // new array (which will be one element longer), rather than that of the current array
  const destinationIndex = index >= 0 ? index : arr.length + 1 + index;
  newArr.splice(destinationIndex, 0, insertee);
  return newArr;
}

/**
 * Create a plugin to add an identification banner to the top of stand-alone bundles.
 *
 * @param title The title to use for the SDK, if not the package name
 * @returns An instance of the `rollup-plugin-license` plugin
 */
function makeLicensePlugin(title) {
  const commitHash = require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();

  return license({
    banner: {
      content: `/*! <%= data.title %> <%= pkg.version %> (${commitHash}) | https://github.com/getsentry/sentry-javascript */`,
      data: { title },
    },
  });
}

export const terserPlugin = terser({
  compress: {
    // Tell env.ts that we're building a browser bundle and that we do not
    // want to have unnecessary debug functionality.
    global_defs: {
      __SENTRY_NO_DEBUG__: false,
    },
  },
  mangle: {
    // captureExceptions and captureMessage are public API methods and they don't need to be listed here
    // as mangler doesn't touch user-facing thing, however sentryWrapped is not, and it would be mangled into a minified version.
    // We need those full names to correctly detect our internal frames for stripping.
    // I listed all of them here just for the clarity sake, as they are all used in the frames manipulation process.
    reserved: ['captureException', 'captureMessage', 'sentryWrapped'],
    properties: {
      regex: /^_[^_]/,
    },
  },
  output: {
    comments: false,
  },
});

export function makeBaseBundleConfig(options) {
  const { input, isAddOn, jsVersion, licenseTitle, outputFileBase } = options;

  const baseTSPluginOptions = {
    tsconfig: 'tsconfig.esm.json',
    tsconfigOverride: {
      compilerOptions: {
        declaration: false,
        declarationMap: false,
        paths: {
          '@sentry/browser': ['../browser/src'],
          '@sentry/core': ['../core/src'],
          '@sentry/hub': ['../hub/src'],
          '@sentry/minimal': ['../minimal/src'],
          '@sentry/types': ['../types/src'],
          '@sentry/utils': ['../utils/src'],
        },
        baseUrl: '.',
      },
    },
    include: ['*.ts+(|x)', '**/*.ts+(|x)', '../**/*.ts+(|x)'],
  };

  const typescriptPluginES5 = typescript(
    deepMerge(baseTSPluginOptions, {
      tsconfigOverride: {
        compilerOptions: {
          target: 'es5',
        },
      },
    }),
  );

  const typescriptPluginES6 = typescript(
    deepMerge(baseTSPluginOptions, {
      tsconfigOverride: {
        compilerOptions: {
          target: 'es6',
        },
      },
    }),
  );

  const nodeResolvePlugin = resolve();

  const markAsBrowserBuildPlugin = replace({
    // don't replace `__placeholder__` where it's followed immediately by a single `=` (to prevent ending up
    // with something of the form `let "replacementValue" = "some assigned value"`, which would cause a
    // syntax error)
    preventAssignment: true,
    // the replacement to make
    values: {
      __SENTRY_BROWSER_BUNDLE__: true,
    },
  });

  const licensePlugin = makeLicensePlugin(licenseTitle);

  // used by `@sentry/browser`, `@sentry/tracing`, and `@sentry/vue` (bundles which are a full SDK in and of themselves)
  const standAloneBundleConfig = {
    output: {
      format: 'iife',
      name: 'Sentry',
    },
    context: 'window',
  };

  // used by `@sentry/integrations` and `@sentry/wasm` (bundles which need to be combined with a stand-alone SDK bundle)
  const addOnBundleConfig = {
    // These output settings are designed to mimic an IIFE. We don't use Rollup's `iife` format because we don't want to
    // attach this code to a new global variable, but rather inject it into the existing SDK's `Integrations` object.
    output: {
      format: 'cjs',

      // code to add before the CJS wrapper
      banner: '(function (__window) {',

      // code to add just inside the CJS wrapper, before any of the wrapped code
      intro: 'var exports = {};',

      // code to add after all of the wrapped code, but still inside the CJS wrapper
      outro: () =>
        [
          '',
          "  // Add this module's exports to the global `Sentry.Integrations`",
          '  __window.Sentry = __window.Sentry || {};',
          '  __window.Sentry.Integrations = __window.Sentry.Integrations || {};',
          '  for (var key in exports) {',
          '    if (Object.prototype.hasOwnProperty.call(exports, key)) {',
          '      __window.Sentry.Integrations[key] = exports[key];',
          '    }',
          '  }',
        ].join('\n'),

      // code to add after the CJS wrapper
      footer: '}(window));',
    },
  };

  // used by all bundles
  const sharedBundleConfig = {
    input,
    output: {
      // a file extension will be added to this base value when we specify either a minified or non-minified build
      file: outputFileBase,
      sourcemap: true,
      strict: false,
      esModule: false,
    },
    plugins: [
      jsVersion === 'es5' ? typescriptPluginES5 : typescriptPluginES6,
      markAsBrowserBuildPlugin,
      nodeResolvePlugin,
      licensePlugin,
    ],
    treeshake: 'smallest',
  };

  return deepMerge(sharedBundleConfig, isAddOn ? addOnBundleConfig : standAloneBundleConfig);
}

export function makeMinificationVariants(existingConfigs) {
  const newConfigs = [];

  // ensure we've got an array of configs rather than a single config
  existingConfigs = Array.isArray(existingConfigs) ? existingConfigs : [existingConfigs];

  existingConfigs.forEach(existingConfig => {
    const { plugins } = existingConfig;

    // The license plugin has to be last, so it ends up after terser. Otherwise, terser will remove the license banner.
    assert(
      getLastElement(plugins).name === 'rollup-plugin-license',
      `Last plugin in given options should be \`rollup-plugin-license\`. Found ${getLastElement(plugins).name}`,
    );

    const minificationVariants = [
      {
        output: {
          file: `${existingConfig.output.file}.js`,
        },
        plugins,
      },
      {
        output: {
          file: `${existingConfig.output.file}.min.js`,
        },
        plugins: insertAt(plugins, -2, terserPlugin),
      },
    ];

    minificationVariants.forEach(variant => {
      const mergedConfig = deepMerge(existingConfig, variant, {
        // this makes it so that instead of concatenating the `plugin` properties of the two objects, the first value is
        // just overwritten by the second value
        arrayMerge: (first, second) => second,
      });
      newConfigs.push(mergedConfig);
    });
  });

  return newConfigs;
}
