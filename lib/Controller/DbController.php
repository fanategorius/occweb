<?php

namespace OCA\OCCWeb\Controller;

use OC;
use OCP\AppFramework\Controller;
use OCP\IRequest;
use OCP\IDBConnection;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IGroupManager;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

class DbController extends Controller
{
    /** Максимум строк, возвращаемых на один SELECT (защита от OOM/DoS). */
    private const MAX_ROWS = 1000;

    /**
     * Конструкции, дающие доступ к файловой системе сервера или запуску
     * внешних программ через SQL. Блокируются полностью, без возможности
     * подтверждения — в отличие от DELETE, это не про потерю данных,
     * а про потенциальный захват сервера.
     */
    private const FORBIDDEN_PATTERNS = [
        '/\bCOPY\b[\s\S]*\bPROGRAM\b/i' => 'COPY ... PROGRAM (запуск внешних команд)',
        '/\bCOPY\b[\s\S]*\b(FROM|TO)\b\s*\'/i' => "COPY ... FROM/TO 'file' (доступ к файловой системе сервера)",
        '/\bpg_read_binary_file\s*\(/i' => 'pg_read_binary_file()',
        '/\bpg_read_file\s*\(/i' => 'pg_read_file()',
        '/\bpg_ls_dir\s*\(/i' => 'pg_ls_dir()',
        '/\bpg_stat_file\s*\(/i' => 'pg_stat_file()',
        '/\blo_import\s*\(/i' => 'lo_import()',
        '/\blo_export\s*\(/i' => 'lo_export()',
        '/\bdblink(_connect)?\s*\(/i' => 'dblink() (подключение к произвольным БД)',
        '/\bLOAD_FILE\s*\(/i' => 'LOAD_FILE()',
        '/\bINTO\s+(OUTFILE|DUMPFILE)\b/i' => 'INTO OUTFILE/DUMPFILE',
    ];

    private $db;
    private $groupManager;
    private $userSession;
    private $logger;

    public function __construct(
        $AppName,
        IRequest $request,
        IDBConnection $db,
        IGroupManager $groupManager,
        IUserSession $userSession
    ) {
        parent::__construct($AppName, $request);
        $this->db = $db;
        $this->groupManager = $groupManager;
        $this->userSession = $userSession;
        // Через OC::$server, как и в OccController — не добавляем LoggerInterface
        // в конструктор, чтобы не менять сигнатуру, резолвящуюся DI-контейнером.
        $this->logger = OC::$server->get(LoggerInterface::class);
    }

    /**
     * Убирает ведущие однострочные комментарии ("-- ...") перед запросом.
     * После разбиения пачки такой комментарий может "приклеиться"
     * к следующему запросу и помешать определить его тип (SELECT/SET/DELETE).
     */
    private function stripLeadingComments($query)
    {
        $query = ltrim($query);
        while (preg_match('/^--[^\n]*\n/', $query)) {
            $query = ltrim(preg_replace('/^--[^\n]*\n/', '', $query, 1));
        }
        return $query;
    }

    /**
     * Разбивает пачку запросов по ";" с учётом одинарных кавычек, чтобы
     * точка с запятой внутри строкового литерала (в том числе с '' как
     * экранированной кавычкой) не ломала разбиение.
     */
    private function splitStatements($sql)
    {
        $statements = [];
        $current = '';
        $len = strlen($sql);
        $inString = false;

        for ($i = 0; $i < $len; $i++) {
            $ch = $sql[$i];

            if ($ch === "'") {
                if ($inString && $i + 1 < $len && $sql[$i + 1] === "'") {
                    $current .= "''";
                    $i++;
                    continue;
                }
                $inString = !$inString;
                $current .= $ch;
                continue;
            }

            if ($ch === ';' && !$inString) {
                $statements[] = trim($current);
                $current = '';
                continue;
            }

            $current .= $ch;
        }

        if (trim($current) !== '') {
            $statements[] = trim($current);
        }

        return array_values(array_filter($statements, function ($s) {
            return $s !== '';
        }));
    }

    /**
     * Возвращает описание найденной запрещённой конструкции (доступ к ФС,
     * запуск программ) или null, если запрос безопасен в этом плане.
     */
    private function findForbiddenConstruct($query)
    {
        foreach (self::FORBIDDEN_PATTERNS as $pattern => $label) {
            if (preg_match($pattern, $query)) {
                return $label;
            }
        }
        return null;
    }

    /**
     * @NoCSRFRequired
     */
    public function query()
    {
        // Проверка прав администратора
        $user = $this->userSession->getUser();
        if (!$user) {
            return new JSONResponse(['error' => 'Not authenticated'], 401);
        }

        if (!$this->groupManager->isAdmin($user->getUID())) {
            return new JSONResponse(['error' => 'Admin privileges required'], 403);
        }

        $sql = $this->request->getParam('sql', '');
        $confirmed = filter_var($this->request->getParam('confirm', false), FILTER_VALIDATE_BOOLEAN);

        if (empty(trim($sql))) {
            return new JSONResponse(['success' => false, 'error' => 'Empty query']);
        }

        // Аудит: логируем сам факт попытки выполнения ДО всех проверок,
        // чтобы в логе остались и заблокированные/отклонённые запросы,
        // а не только успешно выполненные.
        $this->logger->warning('[occweb] SQL submitted by {user}: {sql}', [
            'app' => 'occweb',
            'user' => $user->getUID(),
            'sql' => $sql,
        ]);

        // Разбиваем пачку по ";" с учётом кавычек (см. splitStatements).
        // Все запросы выполняются последовательно на одном и том же
        // соединении с БД (в рамках одного HTTP-запроса), поэтому SET
        // сохраняет своё значение для current_setting() в следующих
        // запросах этой же пачки.
        $queries = $this->splitStatements($sql);

        // Доступ к файловой системе сервера / запуск программ через SQL
        // блокируется полностью — это не про потерю данных (как DELETE),
        // а про потенциальный захват сервера, подтверждением не обходится.
        foreach ($queries as $query) {
            $forbidden = $this->findForbiddenConstruct($query);
            if ($forbidden !== null) {
                $this->logger->error('[occweb] Blocked forbidden construct ({construct}) from {user}: {sql}', [
                    'app' => 'occweb',
                    'construct' => $forbidden,
                    'user' => $user->getUID(),
                    'sql' => $sql,
                ]);
                return new JSONResponse([
                    'success' => false,
                    'error' => "Query blocked: contains a forbidden construct ({$forbidden}). File/program access via SQL is not allowed."
                ]);
            }
        }

        // DELETE необратим, поэтому требуем явное подтверждение с клиента
        // (confirm=true), прежде чем выполнять хоть один запрос из пачки.
        $deleteCount = 0;
        foreach ($queries as $query) {
            if (stripos($this->stripLeadingComments($query), 'DELETE') === 0) {
                $deleteCount++;
            }
        }

        if ($deleteCount > 0 && !$confirmed) {
            return new JSONResponse([
                'success' => false,
                'requiresConfirmation' => true,
                'deleteCount' => $deleteCount,
                'error' => "Batch contains {$deleteCount} DELETE statement(s) and was not executed. Resend with confirm=true to proceed."
            ]);
        }

        $results = [];

        foreach ($queries as $query) {
            $normalized = $this->stripLeadingComments($query);
            $isSelect = stripos($normalized, 'SELECT') === 0;
            $isSet = stripos($normalized, 'SET ') === 0;
            $isDelete = stripos($normalized, 'DELETE') === 0;

            try {
                $stmt = $this->db->prepare($query);
                $stmt->execute();

                if ($isSelect) {
                    // Читаем построчно и останавливаемся на MAX_ROWS, а не
                    // fetchAll() + array_slice — иначе SELECT без LIMIT на
                    // огромной таблице всё равно утащит всё в память PHP.
                    $rows = [];
                    $truncated = false;
                    while (($row = $stmt->fetch()) !== false) {
                        if (count($rows) >= self::MAX_ROWS) {
                            $truncated = true;
                            break;
                        }
                        $rows[] = $row;
                    }
                    $results[] = [
                        'query' => $query,
                        'type' => 'select',
                        'count' => count($rows),
                        'truncated' => $truncated,
                        'data' => $rows
                    ];
                } else {
                    $affected = $stmt->rowCount();
                    $type = $isSet ? 'set' : ($isDelete ? 'delete' : 'write');
                    $results[] = [
                        'query' => $query,
                        'type' => $type,
                        'affected_rows' => $affected
                    ];
                }
            } catch (\Exception $e) {
                $results[] = [
                    'query' => $query,
                    'type' => 'error',
                    'error' => $e->getMessage()
                ];
                // Останавливаемся на первой ошибке: не продолжаем выполнять
                // оставшиеся запросы пачки (например, серию DELETE),
                // если один из предыдущих шагов не выполнился.
                break;
            }
        }

        return new JSONResponse(['success' => true, 'results' => $results]);
    }
}
