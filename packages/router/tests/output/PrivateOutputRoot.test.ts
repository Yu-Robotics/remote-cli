import { PrivateOutputRoot } from '../../src/output/PrivateOutputRoot';
import { durableJson } from '../../src/output/Durable';
import { testPrivateOutputRoot } from '../../../../tests/contracts/PrivateOutputRoot';

testPrivateOutputRoot(PrivateOutputRoot, durableJson);
