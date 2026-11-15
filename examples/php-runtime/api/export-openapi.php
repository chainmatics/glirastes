<?php
declare(strict_types=1);
require __DIR__ . '/contract.php';
echo json_encode(fixture_contract(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
