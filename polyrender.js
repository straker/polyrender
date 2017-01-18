/**
 * NOTES:
 * - read polymer file directly and don't use separate template file
 * - how to read styles and use on server render and then not use
 *   on PE?
 * - content tag support
 */

var fs = require('fs');
var htmlparser = require("htmlparser2");

// dynamic attributes end in a $
var dynamicAttributeBindingRegex = /\$$/;

// a binding is any text inside {{}} or [[]]
var bindingRegex = /\[\[([^\[\]\{\}]+?)\]\]|\{\{([^\[\]\{\}]+?)\}\}/g;

// functions as bindings will use () at the end of the string
var isFunctionRegex = /.+\([^\)]*\)$/;

// template to compiled string lookup table
var templateCache = {};

// registered elements
var elements = {};

var polyrender = {

  /**
   * Find all instances of polymer bindings and save them as insertion points into
   * the source string.
   * @param {string} source
   * @param {boolean} returnBuffer - return buffer string instead of dom string
   */
  compile: function(source, returnBuffer) {
    if (templateCache[source]) {
      return templateCache[source];
    }

    var code = `(function(context) {
  with(context || {}) {
    ___vars___
    var _buffer = '[`;

    // save variables so we can declare them with defaults to prevent compilation
    var variables = [];
    var varibleNames = {};

    /**
     * Define a variable before it is used.
     * @param {*} value
     */
    function defineVariable(value) {

      // remove not operator
      value = value.replace(/^!/, '');

      // don't re-declare a variable
      if (varibleNames[value]) return;

      var useVar = false;

      // nested variable
      if (value.indexOf('.') !== -1) {
        var props = value.split('.');

        for (var i = 0; i < props.length - 1; i++) {
          if (varibleNames[props[i]]) continue;

          // support function bindings
          if (isFunctionRegex.test(props[i])) {
            var fn = props[i].substring(0, props[i].indexOf('('));
            variables.push(`${i === 0 ? 'var ' : ''}${fn} = ${fn} || function(){})`);
            varibleNames[fn] = true;
          }
          else {
            variables.push(`${i === 0 ? 'var ' : ''}${props[i]} = ${props[i]} || {}`);
            varibleNames[props[i]] = true;
          }
        }
      }
      else {
        useVar = true;
      }

      // support function bindings
      var isFunction = isFunctionRegex.test(value);
      if (isFunction) {
        value = value.substring(0, value.indexOf('('))
      }

      // 0 is a valid value so we need to check for undefined
      variables.push(`${(useVar ? 'var ' : '')}${value} = (${value} !== undefined ? ${value} : ${(isFunction ? 'function(){}' : '\'\'')})`);
      varibleNames[value] = true;
    }

    /**
     * Parse a string for bindings.
     * @param {string} str
     */
    function parseStringForBindings(str) {
      str = str || '';
      var result = '';

      str = str.replace(/\n/g, '\\\\n');
      var splitStr = str.split(bindingRegex);

      for (var i = 0; i < splitStr.length; i += 3) {
        if (splitStr[i]) {
          result += `'${splitStr[i]}'`;
        }

        // the regex has two capture groups ( one for {{}} and another for [[]] )
        // so the result of the split will leave a value of 'undefined' for one
        // of the two capture groups
        // e.g. 'hello {{bob}}'.split(bindingRegex) = ['hello ', 'bob', undefined, ''];
        if (splitStr[i+1] || splitStr[i+2]) {
          result += (splitStr[i] ? ' + ' : '');

          // one way binding
          if (splitStr[i+1] !== undefined) {
            result += splitStr[i+1];
            defineVariable(splitStr[i+1]);
          }
          // two way binding
          else {
            result += splitStr[i+2];
            defineVariable(splitStr[i+2]);
          }

          result += (splitStr[i+3] ? ' + ' : '');
        }
      }

      return result;
    }

    /**
     * Parse attribute for bindings.
     * @param attr - Attribute to parse.
     * @param {boolean} camelCase - Camel case attribute names.
     */
    function parseAttributes(attr, camelCase) {
      str = '';

      for (var attrName in attr) {
        if (!attr.hasOwnProperty(attrName)) continue;

        var attrValue = attr[attrName];

        // remove any dynamic attribute names since they can just use their
        // regular name
        attrName = attrName.replace(dynamicAttributeBindingRegex, '');

        if (camelCase) {
          attrName = attrName.replace(/-([a-z])/g, function (g) { return g[1].toUpperCase(); });
        }

        var bindings = parseStringForBindings(attrValue);
        str += `"${attrName}": "' + ${bindings} + '", `;
      }

      return str;
    }

    /**
     * Find the dom-module tag and then the first template tag (typically the first child).
     * @param error - Error object.
     * @param dom - Array of dom objects.
     *
     * NOTE: Current Polymer components follow the below pattern, so this parser only
     * looks for a dom-module at the root level and a template tag as a direct child.
     *
     * <dom-module id="x-foo">
     *   <template>I am x-foo!</template>
     *   <script>
     *     Polymer({
     *       is: 'x-foo'
     *     });
     *   </script>
     * </dom-module>
     */
    function lookForTemplate(error, dom, domModuleFound) {
      for (var i = 0, el; (el = dom[i]); i++) {
        if (el.name === 'dom-module' && el.type === 'tag') {
          for (var j = 0, childEl; (childEl = el.children[j]); j++) {
            if (childEl.name === 'template' && childEl.type === 'tag') {
              parseDomObject(childEl.children, 0);
            }
          }
        }
      }
    }

    /**
     * Parse a DOM object looking for data bindings.
     * @param {array} dom - Array of dom objects
     * @param {number} depth - Depth of the dom object.
     */
    function parseDomObject(dom, depth) {
      if (!Array.isArray(dom)) return '';

      // if (!depth) {
      //   console.log(JSON.stringify( dom, function( key, value) {
      //     if( key == 'parent' || key == 'prev' || key == 'next') {
      //       return '';
      //     }
      //     else {
      //       return value;
      //     }
      //   }, 2));
      // }

      var str = '';

      for(var i = 0, el; (el = dom[i]); i++) {

        // handle template tags differently since they don't get added to the dom
        if (el.name === 'template') {

          // dom-if
          if (el.attribs && el.attribs.is === 'dom-if') {
            var bindings = parseStringForBindings(el.attribs.if);

            str += `' + (${bindings} ? '${parseDomObject(el.children, depth + 1)}' : '') + '`;
          }

          // dom-repeat
          else if (el.attribs && el.attribs.is === 'dom-repeat') {
            var bindings = parseStringForBindings(el.attribs.items);
            var filterFn = el.attribs.filter;

            // remove circular references from dom object so we can stringify the result
            var children = JSON.stringify( el.children, function( key, value) {
              if( key == 'parent' || key == 'prev' || key == 'next') {
                return null;
              }
              else {
                return value;
              }
            });

            // create a new function that will create the repeated dom at run-time
            str += `' + (function(scope) {
              var str = '';
              var childSource = scope.getOuterHTML(${children});
              var template = scope.compile(childSource, true);
              var index = 0;

              for (var i = 0; i < ${bindings}.length; i++) {
                var item = ${bindings}[i];

                ${(filterFn ? 'if (context.' + filterFn + '(item)) {' : '')}
                  var newContext = {
                    ${(el.attribs['index-as'] ? el.attribs['index-as'] : 'index')}: index,
                    ${(el.attribs.as ? el.attribs.as : 'item')}: item,
                    items: ${bindings}
                  };
                  var dom = template(newContext);

                  // remove start and end brackets []
                  str += dom.substring(1, dom.length - 1) + ', ';

                  index++;
                ${(filterFn ? '}' : '')}
              }

              return str;
            })(this) + '`;
          }
        }
        else {
          str += `{`;

          // loop each dom attribute
          for (var prop in el) {
            if (!el.hasOwnProperty(prop)) continue;

            var value = el[prop];

            switch (prop) {

              // type and name cannot have bindings
              case 'type':
              case 'name':
                str += `"${prop}": "${value}", `;
                break;

              // attributes can contain bindings as well as dom-is and dom-repeats
              case 'attribs':
                str += `"attribs": {`;
                str += parseAttributes(value);
                str += `}, `;
                break;

              // parse text values for bindings
              case 'data':
                var bindings = parseStringForBindings(value);

                str += `"data": "' + ${bindings} + '", `;
                break;

              // traverse children nodes
              case 'children':
                str += `"children": [`;

                // registered element
                if (elements[el.name]) {
                  var element = elements[el.name];

                  // transfer attributes from parent to child context
                  var attribueContext = `{${parseAttributes(el.attribs, true)}}`;

                  // remove any string concatenation since this doesn't get compiled
                  attribueContext = attribueContext.replace(/' \+ '/g, '').replace(/"' \+ /g, '').replace(/ \+ '"/g, '');

                  str += `' + (function(scope) {
                    var template = scope.compile(\`${element.source}\`, true);

                    var newContext = Object.assign(${attribueContext}, context, ${element.context});
                    var dom = template(newContext);

                    // remove start and end brackets []
                    return dom.substring(1, dom.length - 1);
                  })(this) + '`;
                }
                else {
                  str += parseDomObject(el.children, depth + 1);
                }

                str += `], `;
                break;
            }
          }

          str += `}, `;
        }
      }

      if (depth > 0) {
        return str;
      }
      else {
        str += `]';\n  }
  // console.log('\\n\\n_buffer:', _buffer);
  return ${returnBuffer ? '_buffer' : 'this.getOuterHTML( JSON.parse(_buffer) )'};
})`;

        // clean up trailing commas
        code += str.replace(/, \}/g, '}').replace(/, \]/g, ']');

        // inject variable names into with() block
        code = code.replace('___vars___', variables.join(';\n    ') + (variables.length ? ';' : ''));

        // map source to code output
        templateCache[source] = code;
      }
    }

    var handler = new htmlparser.DomHandler(lookForTemplate, {
      lowerCaseTags: true
    });
    var parser = new htmlparser.Parser(handler);
    parser.write(source);
    parser.end();

    console.log('\n\ncode:', code);
    return eval(code).bind({
      getOuterHTML: htmlparser.DomUtils.getOuterHTML,
      compile: polyrender.compile
    });
  },

  /**
   * Register an Polymer element, akin to a partial in Handlebars.
   * @param {string} name - Name of the web component element.
   * @param {string} source - Source of the web component element.
   */
  registerElement: function(name, source, context) {
    var strContext = [];

    // convert the object into a string while keeping functions compilable
    for (var prop in context) {
      if (!context.hasOwnProperty(prop)) continue;

      var value = context[prop];
      var str = prop + ': ';

      if (typeof value === 'string') {
        str += `'${value}'`;
      }
      else {
        str += value;
      }

      strContext.push(str);
    }

    elements[name] = {
      source: source,
      context: '{' + strContext.join(', ') + '}'
    };
  }
};

polyrender.registerElement('my-element', '<dom-module><template><button><content></content></button></template></dom-module>');

var template = polyrender.compile(`<dom-module>
  <template>
    <div>
      <my-element>
        Hello World
      </my-element>
    </div>
  </template>
</dom-module>`);

console.log(template());

// polyrender.registerElement('nested-element', '<div>{{test}}</div>', {
//   test: 'hello world'
// });

// polyrender.registerElement('my-element', `<div>
//   <span>{{baz()}}</span><span>{{myName}}</span>
//   <nested-element></nested-element>
// </div>`, {
//   baz: function() {
//     return 'hello world';
//   }
// });
// var template = polyrender.compile(`<my-element value="Bob" my-name={{foo.first}}></my-element>`);

// var template = polyrender.compile(`<div>
//   <template is="dom-repeat" items="{{employees}}" filter="filterList" as="employee" index-as="myIndex">
//     <div># <span>{{myIndex}}</span></div>
//     <div>First name: <span>{{employee.first}}</span></div>
//     <div>Last name: <span>{{employee.last}}</span></div>
//   </template>
// </div>
// `);
// console.log('\n\n\n' + template({
//   bar: {
//     myFunc: function(item) { return 'hello ' + item.first; }
//   },
//   foo: {first: 'Bob', last: 'Marley'},
//   employees: [{first: 'Steven', last: 'Lambert'}, {first: 'John'}],
//   filterList: function(item) {
//     // console.log('filterList:', item);
//     if (item.first === 'Steven') return false;
//     return true;
//   }
// }) );
// console.log(template({baz: false, bar: 'one'}));

/*

  <span class="double-curly-text">{{foo}}</span>
  <span class="double-bracket-text">[[foo]]</span>
  <span on-click="ignore"></span>
  <span id="{{bar}}" class="double-curly-attribute">{single}</span>
  <span id="[[bar]]" class="double-bracket-attribute">[single]</span>
  <span>{{{triple}}}</span>
  <span>[[[triple]]]</span>

  <div>
    <div>
      <template is="dom-if" if="{{baz}}">
        Only admins will see this.
        <div>{{bar}}</div>
      </template>
    </div>
    <template is="dom-if" if="[[baz]]">
      Only admins will see this.
      <div>[[bar]]</div>
    </template>
  </div>

  <template is="dom-repeat" items="{{employees}}">
    <div># <span>{{index}}</span></div>
    <div>First name: <span>{{item.first}}</span></div>
    <div>Last name: <span>{{item.last}}</span></div>
  </template>
</div>
*/

module.exports = polyrender;

// var fsPerson = fs.readFileSync(require('path').join(__dirname, 'assets/html/fs-person/fs-person.html'), 'utf-8');
// var template = polyrender.compile(fsPerson);

// person = {
//   id: 'KWN5-3PH',
//   name: 'Hugh Sidley Gowans',
//   gender: 'male',
//   lifeSpan: '1832–1912',
//   fullLifeSpan: '23 February 1832 – 10 September 1912',
//   portraitUrl: null
// };

// console.log(template({
//   person: person,
//   lifeSpan: person.fullLifeSpan ? person.fullLifeSpan : person.lifeSpan
// }));