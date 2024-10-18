//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

import {OrderFee} from "./OrderFee.sol";
import {ParameterError} from "@synthetixio/core-contracts/contracts/errors/ParameterError.sol";

library FeeTier {
    struct Data {
        uint256 feeTierId;
        uint256 makerDiscount;
        uint256 takerDiscount;
    }

    function load(uint256 feeTierId) internal pure returns (Data storage feeTier) {
        bytes32 s = keccak256(abi.encode("fi.polynomial.perps-market.FeeTier", feeTierId));
        assembly {
            feeTier.slot := s
        }
    }

    function setFeeTier(Data storage self, uint256 makerDiscount, uint256 takerDiscount) internal {
        // check discount should not be more than 100%

        if (makerDiscount > 10000) {
            revert ParameterError.InvalidParameter(
                "makerDiscount",
                "Maker discount should not be more than 100%"
            );
        }
        if (takerDiscount > 10000) {
            revert ParameterError.InvalidParameter(
                "takerDiscount",
                "Taker discount should not be more than 100%"
            );
        }

        self.makerDiscount = makerDiscount;
        self.takerDiscount = takerDiscount;
    }

    function getFees(
        Data storage self,
        OrderFee.Data storage orderFee
    ) internal view returns (OrderFee.Data memory fee) {
        uint256 makerFee = orderFee.makerFee;
        uint256 takerFee = orderFee.takerFee;

        if (self.makerDiscount > 0) {
            makerFee = (makerFee * (10000 - self.makerDiscount)) / 10000;
        }
        if (self.takerDiscount > 0) {
            takerFee = (takerFee * (10000 - self.takerDiscount)) / 10000;
        }

        fee.makerFee = makerFee;
        fee.takerFee = takerFee;
    }
}
