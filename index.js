'use strict';

var common = require('./rules/common.json');
var sMarketplace = require('./rules/marketplace.json');

// TODO: These should probably go somewhere better.
var DEFAULT_WEBAPP_MRKT_URLS = [
  "https://marketplace.firefox.com",
  "https://marketplace-dev.allizom.org"
];

var Warning = function (message) {
  this.name = 'Warning';
  this.message = message || '';
};

Warning.prototype = Error.prototype;

// Stealing some notions from underscore.js
var ObjProto = Object.prototype;
var toString = ObjProto.toString;

var clean = function (word) {
  return word.toString().trim();
};

var camelCase = function (word) {
  var words = word.split('_');
  var finalWord = [];

  words.forEach(function (w) {
    finalWord.push(clean(w.charAt(0).toUpperCase() + w.slice(1)));
  });

  return finalWord.join('');
};

var glueKey = function (prefix, parents, name) {
  var parts = [];
  for (var i=0, part; part=parents[i]; i++) {
    parts.push(camelCase(part));
  }
  if (name) {
    parts.push(camelCase(name));
  }
  return prefix + parts.join('');
};

var parseUrl = function (path) {
  // TODO: Could replace this with a different implementation to make it
  // node-agnostic and work in a browser. http://nodejs.org/api/url.html
  return require('url').parse(path);
};

var pathValid = function (path, options) {

  if (path == '*') {
    return !!options.canBeAsterisk;
  }

  if (path.indexOf('data:') !== -1) {
    return !!options.canBeData;
  }

  // Nothing good comes from relative protocols.
  if (path.indexOf('//') === 0) {
    return false;
  }

  // Try to parse the URL.
  try {
    var parsed = parseUrl(path);

    // If the URL is relative, return whether the URL can be relative.
    if (!parsed.protocol || !parsed.host) {
      if (parsed.pathname && parsed.pathname.indexOf('/') === 0) {
        return !!options.canBeAbsolute;
      } else {
        return !!options.canBeRelative;
      }
    }

    // If the URL is absolute but uses an invalid protocol, return False
    if (['http:', 'https:'].indexOf(parsed.protocol.toLowerCase()) === -1) {
      return false;
    }

    return !!options.canHaveProtocol;

  } catch (e) {
    // If there was an error parsing the URL, return False.
    return false;
  }

};

var Manifest = function () {
  this.manifest;
  this.appType = 'mkt';

  var errors = {};
  var warnings = {};

  var self = this;

  var hasValidJSON = function (content) {
    try {
      if (typeof content !== 'object') {
        self.manifest = JSON.parse(content);
      } else {
        self.manifest = content;
      }
    } catch (err) {
      throw new Error('Manifest is not in a valid JSON format or has invalid properties');
    }
  };

  var hasValidSchema = function (subject, schema, parents) {
    hasMandatoryKeys(subject, schema, parents);
    hasNoUnexpectedKeys(subject, schema, parents);
    hasValidPropertyTypes(subject, schema, parents);
    hasValidItemTypes(subject, schema, parents);
    hasValidStringItem(subject, schema, parents);
    hasRequiredLength(subject, schema, parents);

    // Recursively check sub-properties, if any.
    if ('properties' in schema) {
      for (var k in schema.properties) {
        if ('properties' in schema.properties[k] && k in subject) {
          hasValidSchema(subject[k], schema.properties[k], parents.concat([k]));
        }
      }
    }
  };

  var hasMandatoryKeys = function (subject, schema, parents) {
    if (!schema.required) {
      return;
    }

    var missingKeys = [];
    var keys = schema.required;

    if (parents.length === 0 && self.appType === 'mkt') {
      keys = keys.concat(sMarketplace.required);
    }

    for (var i = 0; i < keys.length; i ++) {
      if (!subject || !subject[keys[i]]) {
        errors[glueKey('MandatoryField', parents, keys[i])] = new Error(
            'Mandatory field ' + keys[i] + ' is missing');
      }
    }
  };

  var hasNoUnexpectedKeys = function (subject, schema, parents) {
    for (var k in subject) {
      if (!(k in schema.properties)) {
        errors[glueKey('UnexpectedProperty', parents, '')] = new Error(
            'Unexpected property `' + k + '` found in `' + parents.join('.') + '`');
      }
    }
  };

  var isValidObjectType = function (prop, type) {
    if ('array' === type) {
      if (toString.call(prop) !== '[object Array]') {
        return false;
      }
    } else if ('object' === type) {
      if (toString.call(prop) !== '[object Object]') {
        return false;
      }
    } else if (typeof prop !== type) {
      return false;
    }
    return true;
  };

  var hasValidPropertyTypes = function (subject, schema, parents) {
    for (var k in subject) {
      if (!(k in schema.properties)) {
        continue;
      }
      var type = schema.properties[k].type;
      if (!isValidObjectType(subject[k], type)) {
        errors[glueKey('InvalidPropertyType', parents, k)] = new Error(
            '`' + k + '` must be of type `' + type + '`');
      }
    }
  };

  var hasValidItemTypes = function (subject, schema, parents) {
    for (var k in subject) {
      if (!(k in schema.properties)) {
        continue;
      }

      // Only validate if this is declared an an array in the schema, and the
      // schema specifies items, and the subject itself is in fact an array.
      var propertySchema = schema.properties[k];
      var arraySubject = subject[k];
      if ('array' !== propertySchema.type || !('items' in propertySchema) ||
          '[object Array]' !== toString.call(arraySubject)) {
        continue;
      }

      var itemSchema = propertySchema.items;

      // TODO: Implement [object Array] form of items schema
      if ('[object Object]' === toString.call(itemSchema)) {
        var type = itemSchema.type;

        // Validate each of the items in the subject array
        for (var i=0; i<arraySubject.length; i++) {
          var itemSubject = arraySubject[i];

          if (!isValidObjectType(itemSubject, type)) {
            errors[glueKey('InvalidItemType', parents, k)] = new Error(
                'items of array `' + k + '` must be of type `' + type + '`');
          }

          if ('properties' in itemSchema) {
            hasValidSchema(itemSubject, itemSchema, parents.concat([k]));
          }

        }
      }

    }
  };

  var hasValidStringItem = function (subject, schema, parents) {
    for (var k in subject) {
      if (!(k in schema.properties)) {
        continue;
      }

      if (schema.properties[k].oneOf && schema.properties[k].oneOf.indexOf(subject[k]) === -1) {
        errors[glueKey('InvalidStringType', parents, k)] = new Error('`' + k +
               '` must be one of the following: ' + schema.properties[k].oneOf.toString());
      } else if (schema.properties[k].anyOf) {
        subject[k].split(',').forEach(function (v) {
          if (schema.properties[k].anyOf.indexOf(v.trim()) === -1) {
            errors[glueKey('InvalidStringType', parents, k)] = new Error('`' + k +
               '` must be any of the following: ' + schema.properties[k].anyOf.toString());
          }
        });
      }
    }
  };

  var hasRequiredLength = function (subject, schema, parents) {
    for (var k in subject) {
      if (!(k in schema.properties)) {
        continue;
      }

      if (schema.properties[k].minLength && subject[k].toString().length < schema.properties[k].minLength) {
        errors[glueKey('InvalidPropertyLength', parents, k)] = new Error(
            '`' + k + '` must not be empty');
      }

      if (schema.properties[k].maxLength && subject[k].toString().length > schema.properties[k].maxLength) {
        errors['InvalidPropertyLength' + camelCase(k)] = new Error(
          '`' + k + '` must not exceed length ' + schema.properties[k].maxLength);
      }
    }
  };

  var hasValidDeveloperUrl = function () {
    if (self.manifest.developer && self.manifest.developer.url) {
      if (!pathValid(self.manifest.developer.url, {canHaveProtocol: true})) {
        errors['InvalidDeveloperUrl'] = new Error('Developer URL must be an absolute HTTP or HTTPS URL');
      }
    }
  };

  var hasValidLaunchPath = function () {
    if (self.manifest.launch_path) {
      var pattern = new RegExp(common.properties.launch_path.pattern);
      var launchPath = clean(self.manifest.launch_path);

      if (launchPath.length > 0) {
        if (pattern.test(launchPath) === false) {
          errors['InvalidLaunchPath'] = new Error("`launch_path` must be a path relative to app's origin");
        }
      }
    }
  };

  // Icon validation is based on a key name that is tied to the icon size. Can't set this in the schema
  // if it is an arbitrary natural number, so this will suffice for current manifest validation.
  var hasValidIconSizeAndPath = function () {
    if (self.manifest.icons) {
      for (var k in self.manifest.icons) {
        var key = parseInt(k, 10);

        if (isNaN(key) || key < 1) {
          errors['InvalidIconSize' + camelCase(k)] = new Error('Icon size must be a natural number');
        }

        if (!self.manifest.icons[k] || self.manifest.icons[k].length < 1) {
          errors['InvalidIconPath' + camelCase(k)] = new Error('Paths to icons must be absolute paths, relative URIs, or data URIs');
        }
      }
    }
  };

  var hasValidVersion = function () {
    if (self.manifest.version) {
      var pattern = new RegExp(common.properties.version.pattern);

      if (pattern.test(clean(self.manifest.version)) === false) {
        errors['InvalidVersion'] = new Error('`version` is in an invalid format.');
      }
    }
  };

  var hasValidDefaultLocale = function () {
    // only relevant if locales property is not empty
    var error = new Error('`default_locale` must match one of the keys in `locales`');

    if (self.manifest.locales) {
      if (!self.manifest.default_locale) {
        errors['InvalidDefaultLocale'] = error;
      } else {
        var languages = [];

        for (var i in self.manifest.locales) {
          languages.push(i);
        }

        if (languages.indexOf(self.manifest.default_locale) === -1) {
          errors['InvalidDefaultLocale'] = error;
        }
      }
    }
  };

  var hasValidInstallsAllowedFrom = function () {
    if (!self.manifest.installs_allowed_from) {
      return;
    }

    var marketURLs = [];

    var invalid = function (subkey, msg) {
      errors['Invalid' + subkey + 'InstallsAllowedFrom'] = new Error(msg);
    };

    if (0 === self.manifest.installs_allowed_from.length) {
      return invalid('Empty', '`installs_allowed_from` cannot be empty when present');
    }

    for (var i=0,item; item=self.manifest.installs_allowed_from[i]; i++) {

      if ('string' !== typeof item) {
        return invalid('ArrayOfStrings',
            '`installs_allowed_from` must be an array of strings');
      }

      var validPath = pathValid(item, {
        canBeAsterisk: true,
        canHaveProtocol: true
      });
      if (!validPath) {
        return invalid('Url',
            '`installs_allowed_from` must be a list of valid absolute URLs or `*`');
      }

      if ('*' === item || DEFAULT_WEBAPP_MRKT_URLS.indexOf(item) !== -1) {
        marketURLs.push(item);
      } else {
        var swap_http = item.replace('http://', 'https://');
        if (DEFAULT_WEBAPP_MRKT_URLS.indexOf(swap_http) !== -1) {
          return invalid('SecureMarketplaceUrl',
              '`installs_allowed_from` must use https:// when Marketplace URLs are included');
        }
      }

    }

    if (self.options.listed && 0 === marketURLs.length) {
      return invalid('ListedRequiresMarketplaceUrl',
          '`installs_allowed_from` must include a Marketplace URL when app is listed');
    }

  };

  var hasValidScreenSize = function () {
    var screenSize = self.manifest.screen_size;

    if (!screenSize || 'object' !== typeof screenSize) {
      return;
    }

    if (!('min_width' in screenSize || 'min_height' in screenSize)) {
      errors['InvalidEmptyScreenSize'] = new Error(
        '`screen_size` should have at least min_height or min_width');
      return;
    }

    var validSize = function (key) {
      var val = screenSize[key];

      if (val && !(/^\d+$/.test(val))) {
        errors['InvalidNumberScreenSize' + camelCase(key)] = new Error(
          '`'+ key +'` must be a number');
      }
    };

    validSize('min_width');
    validSize('min_height');
  };

  var hasValidType = function () {
    var type = self.manifest.type;

    if (!type) {
      return;
    }

    if (self.options.listed && 'certified' === self.manifest.type) {
      errors['InvalidTypeCertifiedListed'] = new Error(
        '`certified` apps cannot be listed');
    }

    if (!self.options.packaged && 'web' !== self.manifest.type) {
      errors['InvalidTypeWebPrivileged'] = new Error(
        'unpackaged web apps may not have a type of `certified` or `privileged`');
    }
  };

  var hasValidAppCachePath = function () {
    var appcachePath = self.manifest.appcache_path;

    if (appcachePath) {
      if (self.options.packaged) {
        if (appcachePath) {
          errors['InvalidAppCachePathType'] = new Error(
            "packaged apps cannot use Appcache. The `appcache_path` field should " +
            "not be provided in a packaged app's manifest");
        }
      }

      if (!pathValid(appcachePath, {canHaveProtocol: true})) {
        errors['InvalidAppCachePathURL'] = new Error(
          'The `appcache_path` must be a full, absolute URL to the application ' +
          'cache manifest');
      }
    }
  };

  this.validate = function (content, options) {
    errors = {};
    warnings = {};

    this.options = options || {
      listed: false,
      packaged: false
    };

    hasValidJSON(content);
    hasValidSchema(self.manifest, common, []);
    hasValidDeveloperUrl();
    hasValidLaunchPath();
    hasValidIconSizeAndPath();
    hasValidVersion();
    hasValidDefaultLocale();
    hasValidInstallsAllowedFrom();
    hasValidScreenSize();
    hasValidType();
    hasValidAppCachePath();

    return {
      errors: errors,
      warnings: warnings
    };
  };
};

module.exports = Warning;
module.exports = Manifest;

/*

Actual rules here https://github.com/mozilla/app-validator/blob/master/appvalidator/specs/webapps.py

var RULES = {
  "disallowed_nodes": ["widget"],
  "child_nodes": {
    "required_features": {"expected_type": "object"},
    "activities": {
        "expected_type": "object",
        "allowed_nodes": ["*"],
        "child_nodes": {
            "*": {
                "expected_type": "object",
                "required_nodes": ["href"],
                "allowed_once_nodes": [
                    "disposition", "filters", "returnValue"
                ],
                "child_nodes": WEB_ACTIVITY_HANDLER,
            }
        }
    },
    "inputs": {
        "expected_type": "object",
        "allowed_nodes": ["*"],
        "not_empty": true,
        "child_nodes": {
            "*": {
                "expected_type": "object",
                "required_nodes": ["launch_path", "name", "description",
                                   "types"],
                "allowed_once_nodes": ["locales"],
                "child_nodes": INPUT_DEF_OBJ
            }
        }
    },
    "permissions": {
        "allowed_nodes": PERMISSIONS['web'] |
                         PERMISSIONS['privileged'] |
                         PERMISSIONS['certified'],
        "expected_type": "object",
        "unknown_node_level": "error",
        "child_nodes": {
            "*": {
                "expected_type": "object",
                "required_nodes": ["description"],
                "allowed_once_nodes": ["access"],
                "child_nodes": {
                    "description": {"expected_type": "string",
                                    "not_empty": true},
                    "access": {"expected_type": "string",
                               "not_empty": true}
                }
            }
        },
        "process": lambda s: s.process_permissions
    },
    "messages": {
        "expected_type": "object",
        "process": lambda s: s.process_messages,
    },
    "redirects": {
        "expected_type": "object",
        "child_nodes": {
            "expected_type": "object",
            "required_nodes": ["to", "from"],
            "child_nodes": {
                "to": {"expected_type": "string",
                       "not_empty": true},
                "from": {"expected_type": "string",
                         "not_empty": true},
            }
        },
    },
    "origin": {
        "expected_type": "string",
        "value_matches": /^app:\/\/[a-z0-9]+([-.{1}[a-z0-9]+)/
                         /\.[a-z]{2,5}$/]
        "process": lambda s: s.process_origin,
    },
  }
};
*/
