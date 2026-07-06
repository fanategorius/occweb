(function(OC, window, $, undefined) {
'use strict';

$(document).ready(function() {
    var sqlMode = false;
    
    var term = $('body').terminal(function(command, term) {
        if (command === '') {
            return;
        }
        
        // Команды переключения режимов
        if (command === ':sql') {
            sqlMode = true;
            term.set_prompt('sql $ ');
            term.echo('SQL mode enabled. Type :occ to return to OCC mode.');
            return;
        }
        
        if (command === ':occ') {
            sqlMode = false;
            term.set_prompt('occ $ ');
            term.echo('OCC mode enabled.');
            return;
        }
        
        if (command === ':help') {
            term.echo('Available commands:');
            term.echo('  :sql  - Switch to SQL mode');
            term.echo('  :occ  - Switch to OCC mode');
            term.echo('  :help - Show this help');
            term.echo('');
            term.echo('In OCC mode: execute Nextcloud occ commands');
            term.echo('In SQL mode: execute SQL queries directly');
            return;
        }
        
        term.pause();
        
        if (sqlMode) {
            // SQL режим
            $.post(OC.generateUrl('/apps/occweb/db/query'), {
                sql: command
            }, function(response) {
                if (response.success) {
                    response.results.forEach(function(result) {
                        if (result.type === 'select') {
                            term.echo('Query: ' + result.query);
                            term.echo('Rows: ' + result.count);
                            if (result.data.length > 0) {
                                term.echo(JSON.stringify(result.data, null, 2));
                            } else {
                                term.echo('(no results)');
                            }
                        } else if (result.type === 'write') {
                            term.echo('Query: ' + result.query);
                            term.echo('Affected rows: ' + result.affected_rows);
                        } else if (result.type === 'set') {
                            term.echo('Skipped: ' + result.query);
                        }
                        term.echo('');
                    });
                } else {
                    term.echo('ERROR: ' + response.error);
                }
                term.resume();
            }).fail(function(xhr, status, error) {
                term.echo('ERROR: Request failed - ' + error);
                term.resume();
            });
        } else {
            // OCC режим
            $.post(OC.generateUrl('/apps/occweb/cmd'), {
                command: command
            }, function(response) {
                term.echo('\n' + response).resume();
            }).fail(function(xhr, status, error) {
                term.echo('ERROR: Request failed - ' + error);
                term.resume();
            });
        }
    }, {
        prompt: 'occ $ ',
        name: 'occweb',
        greetings: 'Nextcloud OCC Web Terminal\nType :help for available commands\n',
        onBlur: function() {
            return false;
        }
    });
});

})(OC, window, jQuery);
