(function (OC, window, $, undefined) {
  'use strict';
  $(function() {
    function scrollToBottom(){
      var html = $('html');
      html.scrollTop(html.prop('scrollHeight'));
    }
    var baseUrl = OC.generateUrl('/apps/occweb');

    // Текущий режим терминала: 'occ' (обычные occ-команды) или 'sql'
    // (выполнение произвольных SQL-запросов через /db/query).
    var mode = 'occ';

    var OCC_PROMPT = 'occ $ ';
    var SQL_PROMPT = '[[;#ff5555;]sql]# ';

    // Быстрая клиентская проверка на DELETE — только для UX (чтобы не
    // делать лишний запрос к серверу). Итоговое решение всё равно
    // принимает бэкенд (requiresConfirmation), это лишь подсказка.
    function scriptHasDelete(sql) {
      return sql.split(';').some(function (part) {
        var normalized = part.replace(/^(\s*--[^\n]*\n)*\s*/, '');
        return /^DELETE\b/i.test(normalized);
      });
    }

    function escapeSqlString(value) {
      return String(value).replace(/'/g, "''");
    }

    // Готовые шаблоны SQL-скриптов. build() возвращает текст скрипта,
    // который вставляется в командную строку через term.set_command() —
    // ничего не выполняется автоматически, пользователь сам проверяет
    // и жмёт Enter (после чего срабатывает обычное подтверждение DELETE).
    var TEMPLATES = {
      'delete-user': {
        args: ['uid'],
        description: 'Полностью удалить локального пользователя (oc_preferences, oc_group_user, oc_ldap_user_mapping, oc_users)',
        build: function (uid) {
          var v = escapeSqlString(uid);
          return [
            "SET vars.old_user = '" + v + "'",
            "SELECT * FROM oc_users WHERE uid = current_setting('vars.old_user')",
            "SELECT * FROM oc_preferences WHERE userid = current_setting('vars.old_user')",
            "DELETE FROM oc_preferences WHERE userid = current_setting('vars.old_user')",
            "DELETE FROM oc_group_user WHERE uid = current_setting('vars.old_user')",
            "DELETE FROM oc_ldap_user_mapping WHERE owncloud_name = current_setting('vars.old_user')",
            "DELETE FROM oc_users WHERE uid = current_setting('vars.old_user')"
          ].join(';\n') + ';';
        }
      },
      'list-user': {
        args: ['uid'],
        description: 'Только посмотреть данные пользователя, без удаления (oc_users, oc_preferences, oc_group_user, oc_ldap_user_mapping)',
        build: function (uid) {
          var v = escapeSqlString(uid);
          return [
            "SET vars.old_user = '" + v + "'",
            "SELECT * FROM oc_users WHERE uid = current_setting('vars.old_user')",
            "SELECT * FROM oc_preferences WHERE userid = current_setting('vars.old_user')",
            "SELECT * FROM oc_group_user WHERE uid = current_setting('vars.old_user')",
            "SELECT * FROM oc_ldap_user_mapping WHERE owncloud_name = current_setting('vars.old_user')"
          ].join(';\n') + ';';
        }
      }
    };

    function listTemplates(term) {
      term.echo('[[;yellow;]Available templates:]');
      Object.keys(TEMPLATES).forEach(function (name) {
        var t = TEMPLATES[name];
        var usage = name + ' ' + t.args.map(function (a) { return '<' + a + '>'; }).join(' ');
        term.echo('[[;#009ae3;]  template ' + usage + ']');
        term.echo('    ' + t.description);
      });
      term.echo('[[;gray;]Fills the command line — review it, then press Enter to run.]');
    }

    function useTemplate(term, name, args) {
      var t = TEMPLATES[name];
      if (!t) {
        term.echo('[[;#ff5555;]Unknown template: ]' + $.terminal.escape_formatting(name || '') + '. Type "templates" to list available ones.');
        return;
      }
      if (args.length < t.args.length) {
        var usage = name + ' ' + t.args.map(function (a) { return '<' + a + '>'; }).join(' ');
        term.echo('[[;#ff5555;]Missing arguments. Usage: ]template ' + usage);
        return;
      }
      var sql = t.build.apply(null, args);
      term.set_command(sql);
      term.echo('[[;yellow;]Template inserted into the command line — review it, then press Enter to run.]');
    }

    // Табличный вывод результатов SELECT в стиле psql.
    function renderTable(term, rows) {
      if (!rows || !rows.length) {
        return;
      }
      var columns = Object.keys(rows[0]);

      function formatCell(v) {
        if (v === null || v === undefined) {
          return '';
        }
        if (typeof v === 'object') {
          return JSON.stringify(v);
        }
        return String(v).replace(/\r?\n/g, '\\n');
      }

      function pad(str, width) {
        str = String(str);
        var diff = width - str.length;
        return diff > 0 ? str + new Array(diff + 1).join(' ') : str;
      }

      var widths = columns.map(function (col) {
        return rows.reduce(function (max, row) {
          return Math.max(max, formatCell(row[col]).length);
        }, col.length);
      });

      function formatRow(cells) {
        return cells.map(function (cell, i) {
          return ' ' + pad(cell, widths[i]) + ' ';
        }).join('|');
      }

      var lines = [];
      lines.push(formatRow(columns));
      lines.push(widths.map(function (w) { return new Array(w + 3).join('-'); }).join('+'));
      rows.forEach(function (row) {
        lines.push(formatRow(columns.map(function (col) { return formatCell(row[col]); })));
      });

      term.echo($.terminal.escape_formatting(lines.join('\n')));
    }

    function renderSqlResponse(term, response) {
      if (!response) {
        term.echo('[[;#ff5555;]Empty response from server]');
        return;
      }
      if (response.success === false) {
        term.echo('[[;#ff5555;]Error: ]' + $.terminal.escape_formatting(response.error || 'unknown error'));
        return;
      }
      var results = response.results || [];
      if (!results.length) {
        term.echo('[[;yellow;]No statements were executed]');
        return;
      }
      results.forEach(function (r) {
        term.echo('[[;#009ae3;]> ]' + $.terminal.escape_formatting(r.query || ''));
        if (r.type === 'error') {
          term.echo('[[;#ff5555;]  Error: ]' + $.terminal.escape_formatting(r.error || 'unknown error'));
        } else if (r.type === 'select') {
          term.echo('[[;gray;]  ' + r.count + ' row(s)]');
          if (r.count > 0) {
            renderTable(term, r.data);
          }
        } else if (r.type === 'set') {
          term.echo('[[;green;]  OK (session variable set)]');
        } else if (r.type === 'delete') {
          term.echo('[[;#ff9900;]  DELETED ' + r.affected_rows + ' row(s)]');
        } else {
          term.echo('[[;green;]  OK, ' + r.affected_rows + ' row(s) affected]');
        }
      });
    }

    function enterSqlMode(term) {
      mode = 'sql';
      term.set_prompt(SQL_PROMPT);
      term.echo('[[;yellow;]Switched to SQL mode. Admin only — statements run directly against the database.]');
      term.echo('[[;gray;]Separate statements with ";". Shift+Enter for a new line, Enter to run. Type "occ" to go back.]');
      term.echo('[[;gray;]Type "templates" to list ready-made scripts (e.g. deleting a user).]');
    }

    function exitSqlMode(term) {
      mode = 'occ';
      term.set_prompt(OCC_PROMPT);
      term.echo('[[;yellow;]Switched back to OCC mode.]');
    }

    function sendSqlQuery(term, sql, confirmed) {
      term.pause();
      $.ajax({
        url: baseUrl + '/db/query',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ sql: sql, confirm: !!confirmed })
      }).done(function (response) {
        if (response && response.requiresConfirmation) {
          term.resume();
          askDeleteConfirmation(term, sql, response.error);
          return;
        }
        renderSqlResponse(term, response);
        term.resume();
      }).fail(function (xhr) {
        term.echo('[[;#ff5555;]Request failed: ]' + $.terminal.escape_formatting(xhr.status + ' ' + xhr.statusText));
        term.resume();
      });
    }

    function askDeleteConfirmation(term, sql, message) {
      var prompt = '[[;#ff5555;]' + (message || 'This script contains DELETE statement(s).') + ' Type "yes" to run it: ]';
      term.read(prompt).then(function (answer) {
        if ((answer || '').trim().toLowerCase() === 'yes') {
          sendSqlQuery(term, sql, true);
        } else {
          term.echo('[[;yellow;]Cancelled — nothing was executed.]');
        }
      }, function () {
        term.echo('[[;yellow;]Cancelled — nothing was executed.]');
      });
    }

    $.get(baseUrl + '/cmd', function(response){
      $('#app-content').terminal(function(command, term) {
        if (mode === 'sql') {
          var trimmed = command.trim();
          if (trimmed === 'occ') {
            exitSqlMode(term);
            return;
          }
          if (trimmed === 'c') {
            term.clear();
            return;
          }
          if (trimmed === 'exit') {
            exitSqlMode(term);
            term.reset();
            return;
          }
          if (trimmed === 'templates') {
            listTemplates(term);
            return;
          }
          if (/^template(\s|$)/i.test(trimmed)) {
            var parts = trimmed.split(/\s+/);
            useTemplate(term, parts[1], parts.slice(2));
            return;
          }
          if (!trimmed) {
            return;
          }
          if (scriptHasDelete(command)) {
            askDeleteConfirmation(term, command);
          } else {
            sendSqlQuery(term, command, false);
          }
          return;
        }

        switch (command) {
        case "c":
          this.clear();
          break;
        case "exit":
          this.reset();
          break;
        case "sql":
          enterSqlMode(term);
          break;
        default:
          var occCommand = {
            command: command
          };
          term.pause();
          $.ajax({
            url: baseUrl + '/cmd',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(occCommand)
          }).done(function (response) {
            term.echo('\n' + response).resume();
          }).fail(function (response, code) {
            term.echo('\n' + response).resume();
          });
        }
      }, {
        greetings: function (callback) {
          callback('[[;green;]' + new Date().toString().slice(0, 24) + "]\n\nPress [[;#ff5e99;]Enter] for more information on [[;#009ae3;]occ] commands.\nType [[;#ff5e99;]sql] to switch to SQL query mode.\n")
        },
        name: 'occ',
        prompt: OCC_PROMPT,
        completion: response,
        keydown: function (e) {
          // Shift+Enter вставляет перевод строки вместо выполнения команды,
          // это позволяет набирать многострочные SQL-скрипты в режиме sql.
          if (e.shiftKey && e.key === 'Enter') {
            this.insert('\n');
            return false;
          }
        },
        onResize: function(){
          scrollToBottom()
        }
      });
    });
    $('html').keypress(function(){
      scrollToBottom()
    })
  });
})(OC, window, jQuery);
