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
            term.echo($.terminal.escape_formatting(JSON.stringify(r.data, null, 2)));
          }
        } else if (r.type === 'set') {
          term.echo('[[;green;]  OK (session variable set)]');
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
    }

    function exitSqlMode(term) {
      mode = 'occ';
      term.set_prompt(OCC_PROMPT);
      term.echo('[[;yellow;]Switched back to OCC mode.]');
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
          if (!trimmed) {
            return;
          }
          term.pause();
          $.ajax({
            url: baseUrl + '/db/query',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ sql: command })
          }).done(function (response) {
            renderSqlResponse(term, response);
            term.resume();
          }).fail(function (xhr) {
            term.echo('[[;#ff5555;]Request failed: ]' + $.terminal.escape_formatting(xhr.status + ' ' + xhr.statusText));
            term.resume();
          });
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
