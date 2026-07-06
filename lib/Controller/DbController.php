<?php

namespace OCA\OCCWeb\Controller;

use OCP\AppFramework\Controller;
use OCP\IRequest;
use OCP\IDBConnection;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IGroupManager;
use OCP\IUserSession;

class DbController extends Controller
{
    private $db;
    private $groupManager;
    private $userSession;

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
    }

    /**
     * Убирает ведущие однострочные комментарии ("-- ...") перед запросом.
     * После разбиения пачки по ";" такой комментарий может "приклеиться"
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

        // Разделяем запросы по точке с запятой. Все запросы выполняются
        // последовательно на одном и том же соединении с БД (в рамках
        // одного HTTP-запроса), поэтому SET сохраняет своё значение
        // для current_setting() в последующих запросах пачки.
        $queries = array_values(array_filter(array_map('trim', explode(';', $sql)), function ($q) {
            return $q !== '';
        }));

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
                    $rows = $stmt->fetchAll();
                    $results[] = [
                        'query' => $query,
                        'type' => 'select',
                        'count' => count($rows),
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
