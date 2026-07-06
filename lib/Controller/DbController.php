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

        $results = [];

        foreach ($queries as $query) {
            $isSelect = stripos($query, 'SELECT') === 0;
            $isSet = stripos($query, 'SET ') === 0;

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
                    $results[] = [
                        'query' => $query,
                        'type' => $isSet ? 'set' : 'write',
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
