<?php

namespace OCA\OCCWeb\Controller;

use OCP\AppFramework\Controller;
use OCP\IRequest;
use OCP\IDBConnection;
use OCP\AppFramework\Http\JSONResponse;

class DbController extends Controller
{
    private $db;

    public function __construct($AppName, IRequest $request, IDBConnection $db)
    {
        parent::__construct($AppName, $request);
        $this->db = $db;
    }

    /**
     * @NoCSRFRequired
     * @PublicPage
     */
    public function query()
    {
        $sql = $this->request->getParam('sql', '');
        
        if (empty($sql)) {
            return new JSONResponse(['error' => 'Empty query']);
        }

        try {
            // Разделяем запросы по точке с запятой
            $queries = array_filter(array_map('trim', explode(';', $sql)));
            $results = [];

            foreach ($queries as $query) {
                if (empty($query)) continue;
                
                // Пропускаем SET команды (PostgreSQL specific)
                if (stripos($query, 'SET ') === 0) {
                    $results[] = ['query' => $query, 'type' => 'set', 'result' => 'skipped'];
                    continue;
                }

                // Определяем тип запроса
                $isSelect = stripos($query, 'SELECT') === 0;
                
                if ($isSelect) {
                    $stmt = $this->db->prepare($query);
                    $stmt->execute();
                    $rows = $stmt->fetchAll();
                    $results[] = [
                        'query' => $query,
                        'type' => 'select',
                        'count' => count($rows),
                        'data' => $rows
                    ];
                } else {
                    $stmt = $this->db->prepare($query);
                    $stmt->execute();
                    $affected = $stmt->rowCount();
                    $results[] = [
                        'query' => $query,
                        'type' => 'write',
                        'affected_rows' => $affected
                    ];
                }
            }

            return new JSONResponse(['success' => true, 'results' => $results]);

        } catch (\Exception $e) {
            return new JSONResponse([
                'success' => false,
                'error' => $e->getMessage(),
                'query' => $sql
            ]);
        }
    }
}
